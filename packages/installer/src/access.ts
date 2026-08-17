import {
  createAccessApplication,
  createAccessOrganization,
  createAccessPolicy,
  createAccessServiceToken,
  createIdentityProvider,
  getAccessApplication,
  getAccessOrganization,
  getAccessServiceToken,
  listAccessApplications,
  listAccessPolicies,
  listAccessServiceTokens,
  listIdentityProviders,
  refreshAccessServiceToken,
  type AccessApplication,
  type AccessIdentityProvider,
  type AccessPolicy,
  type CloudflareAuthorization,
} from "./cloudflare-api";
import { canonicalJson } from "./release";
import type { InstallationResourcesV1 } from "./types";

const SERVICE_TOKEN_YEAR_MS = 365 * 24 * 60 * 60 * 1_000;
const EXPIRATION_TOLERANCE_MS = 24 * 60 * 60 * 1_000;
export const PUBLIC_BYPASS_PATHS = ["/health", "/api/github/webhook"] as const;

export class AccessConflictError extends Error {
  constructor(message = "Cloudflare Access already has a conflicting Tiller destination") {
    super(message);
    this.name = "AccessConflictError";
  }
}

export class AccessPropagationError extends Error {
  constructor() {
    super("Cloudflare's account-member identity provider has not propagated yet");
    this.name = "AccessPropagationError";
  }
}

function required(value: string | null | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`Cloudflare did not return ${label}`);
  return normalized;
}

function restrictedIdp(value: AccessIdentityProvider | undefined, id?: string): boolean {
  return value?.type === "cloudflare"
    && value.read_only !== true
    && value.config?.restrict_to_account_members === true
    && (id === undefined || value.id?.trim() === id);
}

function emptyRule(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0);
}

interface DesiredAccessPolicy extends Record<string, unknown> {
  name: string;
  decision: string;
  include: unknown[];
}

function exactPolicy(policy: AccessPolicy | undefined, desired: DesiredAccessPolicy, id?: string): boolean {
  return Boolean(policy)
    && (id === undefined || policy!.id?.trim() === id)
    && policy!.name === desired.name
    && policy!.decision === desired.decision
    && Array.isArray(policy!.include)
    && JSON.stringify(policy!.include) === JSON.stringify(desired.include)
    && emptyRule(policy!.exclude)
    && emptyRule(policy!.require);
}

function ownerPolicyDesired(ownerEmail: string): DesiredAccessPolicy {
  return { name: "Allow Tiller owner", decision: "allow", include: [{ email: { email: ownerEmail } }] };
}

function servicePolicyDesired(tokenId: string): DesiredAccessPolicy {
  return {
    name: "Allow Tiller service token",
    decision: "non_identity",
    include: [{ service_token: { token_id: tokenId } }],
  };
}

const PUBLIC_POLICY_DESIRED: DesiredAccessPolicy = {
  name: "Allow Tiller public endpoints",
  decision: "bypass",
  include: [{ everyone: {} }],
};

interface DesiredAccessApplication extends Record<string, unknown> {
  type: string;
  name: string;
  domain?: string;
  destinations: NonNullable<AccessApplication["destinations"]>;
  allowed_idps?: string[];
  auto_redirect_to_identity?: boolean;
  app_launcher_visible: boolean;
  service_auth_401_redirect?: boolean;
  session_duration: string;
}

function exactApplication(app: AccessApplication, desired: DesiredAccessApplication): boolean {
  const destinations = (app.destinations ?? []).map((destination) => ({ ...destination }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const desiredDestinations = desired.destinations.map((destination) => ({ ...destination }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const actual = {
    type: app.type,
    name: app.name,
    ...(app.domain !== undefined ? { domain: app.domain } : {}),
    destinations,
    ...(desired.allowed_idps ? { allowed_idps: [...(app.allowed_idps ?? [])].sort() } : {}),
    ...(desired.auto_redirect_to_identity !== undefined
      ? { auto_redirect_to_identity: app.auto_redirect_to_identity }
      : {}),
    app_launcher_visible: app.app_launcher_visible,
    ...(desired.service_auth_401_redirect !== undefined
      ? { service_auth_401_redirect: app.service_auth_401_redirect }
      : {}),
    session_duration: app.session_duration,
  };
  return canonicalJson(actual) === canonicalJson({
    ...desired,
    destinations: desiredDestinations,
    ...(desired.allowed_idps ? { allowed_idps: [...desired.allowed_idps].sort() } : {}),
  });
}

function workerApplicationDesired(
  args: { workerId: string; hostname: string; idpId: string; installationId: string },
): DesiredAccessApplication {
  return {
    type: "self_hosted",
    name: `Tiller Hub (${args.installationId})`,
    destinations: [{ type: "worker", worker_id: args.workerId }],
    allowed_idps: [args.idpId],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
    service_auth_401_redirect: true,
    session_duration: "24h",
  };
}

function publicApplicationDesired(hostname: string, installationId: string): DesiredAccessApplication {
  const destinations = PUBLIC_BYPASS_PATHS.map((path) => ({
    type: "public",
    uri: `${hostname}${path}`,
  }));
  return {
    type: "self_hosted",
    name: `Tiller public endpoints (${installationId})`,
    domain: destinations[0].uri,
    destinations,
    app_launcher_visible: false,
    session_duration: "24h",
  };
}

function exactWorkerApplication(
  app: AccessApplication,
  args: { workerId: string; hostname: string; idpId: string; installationId: string },
): boolean {
  return exactApplication(app, workerApplicationDesired(args));
}

function exactPublicApplication(app: AccessApplication, hostname: string, installationId: string): boolean {
  return exactApplication(app, publicApplicationDesired(hostname, installationId));
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/** Build the immutable Zero Trust team label for a fresh installation. */
export function accessTeamLabel(workersDevHostname: string, installationId: string): string {
  if (!/^[a-z2-7]{26}$/.test(installationId)) throw new Error("Installation ID is invalid");
  const hostname = normalizeHostname(workersDevHostname);
  const prefix = "tiller.";
  const suffix = ".workers.dev";
  if (!hostname.startsWith(prefix) || !hostname.endsWith(suffix)) {
    throw new Error("workers.dev hostname is invalid");
  }
  const accountPrefix = hostname.slice(prefix.length, -suffix.length)
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!accountPrefix) throw new Error("workers.dev prefix is invalid");
  const installationSuffix = `-tiller-${installationId}`;
  const readablePrefix = accountPrefix
    .slice(0, 63 - installationSuffix.length)
    .replace(/-+$/g, "");
  if (!readablePrefix) throw new Error("workers.dev prefix is invalid");
  return `${readablePrefix}${installationSuffix}`;
}

function publicDestinationCoversHostname(value: string, hostnameInput: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\s\\]/.test(trimmed)) return true;
  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return true;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return true;
  const patternHostname = normalizeHostname(parsed.hostname);
  const hostname = normalizeHostname(hostnameInput);
  if (patternHostname === hostname) return true;
  if (!patternHostname.includes("*")) return false;
  const pattern = patternHostname.split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(hostname);
}

export function destinationCanConflict(app: AccessApplication, workerId: string, hostname: string): boolean {
  const legacyDomain = app.domain?.trim() ?? "";
  if (legacyDomain && publicDestinationCoversHostname(legacyDomain, hostname)) return true;
  if (!Array.isArray(app.destinations)) return false;
  return app.destinations.some((destination) => {
    if (destination.type === "worker") return destination.worker_id === workerId;
    if (destination.type === "all_workers"
      || destination.type === "preview_worker"
      || destination.type === "all_preview_workers") return true;
    if (destination.type !== "public" || typeof destination.uri !== "string") return true;
    return publicDestinationCoversHostname(destination.uri, hostname);
  });
}

function accessIssuer(authDomainInput: string | null | undefined): string {
  const authDomain = required(authDomainInput, "the Zero Trust auth domain").toLowerCase();
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(authDomain)) {
    throw new AccessConflictError("The existing Zero Trust organization has an unsupported auth domain");
  }
  return `https://${authDomain}`;
}

function oneYearExpiration(value: string | null | undefined, referenceTime: number): string {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed)
    || Math.abs((parsed - referenceTime) - SERVICE_TOKEN_YEAR_MS) > EXPIRATION_TOLERANCE_MS) {
    throw new Error("Cloudflare returned an unexpected Access expiration");
  }
  return new Date(parsed).toISOString();
}

function mainDesired(resources: InstallationResourcesV1): Record<string, unknown> {
  return workerApplicationDesired({
    workerId: required(resources.workerId, "the Worker ID"),
    hostname: resources.workersDevHostname,
    idpId: required(resources.accessIdentityProviderId, "an Access identity provider ID"),
    installationId: resources.installationId,
  });
}

function publicDesired(resources: InstallationResourcesV1): Record<string, unknown> {
  return publicApplicationDesired(resources.workersDevHostname, resources.installationId);
}

export type AccessMutation = <T>(operation: () => Promise<T>) => Promise<T>;

export type FreshAccessStepResult = {
  done: boolean;
  resources: InstallationResourcesV1;
  serviceClientSecret?: string;
};

export type FreshAccessMutation = (
  operation: () => Promise<FreshAccessStepResult>,
) => Promise<FreshAccessStepResult>;

/**
 * Proves that the Access resources named by the installed Worker still form
 * the installer-managed policy set. Maintenance never discovers or adopts an
 * alternative application, policy, identity provider, or service token.
 */
async function validateManagedAccessState(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  resources: InstallationResourcesV1;
  ownerEmail: string;
  allowExpirationMismatch: boolean;
}): Promise<string> {
  const resources = { ...args.resources, ownerEmail: args.ownerEmail };
  const organization = await getAccessOrganization(args.authorization, args.accountId);
  if (!organization || accessIssuer(organization.auth_domain) !== resources.accessIssuer) {
    throw new AccessConflictError("The Tiller Zero Trust organization changed");
  }

  const idpId = required(resources.accessIdentityProviderId, "an Access identity provider ID");
  const providers = await listIdentityProviders(args.authorization, args.accountId);
  if (!restrictedIdp(providers.find((provider) => provider.id?.trim() === idpId), idpId)) {
    throw new AccessConflictError("The Tiller account-member identity provider changed");
  }

  const tokenId = required(resources.accessServiceTokenId, "an Access service token ID");
  const clientId = required(resources.accessServiceClientId, "an Access service client ID");
  const token = await getAccessServiceToken(args.authorization, args.accountId, tokenId);
  const actualExpirationMs = Date.parse(token.expires_at ?? "");
  const actualExpiration = Number.isFinite(actualExpirationMs)
    ? new Date(actualExpirationMs).toISOString()
    : "";
  if (token.id?.trim() !== tokenId
    || token.name !== `Tiller (${resources.installationId})`
    || token.client_id?.trim() !== clientId
    || !actualExpiration
    || (!args.allowExpirationMismatch && actualExpiration !== resources.accessTokenExpiresAt)) {
    throw new AccessConflictError("The Tiller Access service token changed");
  }

  const workerId = required(resources.workerId, "the Worker ID");
  const mainId = required(resources.accessApplicationId, "an Access application ID");
  const publicId = required(resources.accessPublicApplicationId, "a public Access application ID");
  const applications = await listAccessApplications(args.authorization, args.accountId);
  if (applications.some((app) => ![mainId, publicId].includes(app.id?.trim() ?? "")
    && destinationCanConflict(app, workerId, resources.workersDevHostname))) {
    throw new AccessConflictError();
  }

  const main = await getAccessApplication(args.authorization, args.accountId, mainId);
  if (!exactWorkerApplication(main, {
    workerId,
    hostname: resources.workersDevHostname,
    idpId,
    installationId: resources.installationId,
  }) || main.aud?.trim() !== resources.accessAudience) {
    throw new AccessConflictError("The Tiller Access application changed");
  }
  const ownerPolicyId = required(resources.accessOwnerPolicyId, "an owner policy ID");
  const servicePolicyId = required(resources.accessServicePolicyId, "a service policy ID");
  const mainPolicies = await listAccessPolicies(args.authorization, args.accountId, mainId);
  if (mainPolicies.length !== 2
    || !exactPolicy(
      mainPolicies.find((policy) => policy.id?.trim() === ownerPolicyId),
      ownerPolicyDesired(args.ownerEmail),
      ownerPolicyId,
    )
    || !exactPolicy(
      mainPolicies.find((policy) => policy.id?.trim() === servicePolicyId),
      servicePolicyDesired(tokenId),
      servicePolicyId,
    )) {
    throw new AccessConflictError("The Tiller Access policies changed");
  }

  const publicApp = await getAccessApplication(args.authorization, args.accountId, publicId);
  if (!exactPublicApplication(publicApp, resources.workersDevHostname, resources.installationId)) {
    throw new AccessConflictError("The Tiller public endpoint application changed");
  }
  const publicPolicyId = required(resources.accessPublicPolicyId, "a public policy ID");
  const publicPolicies = await listAccessPolicies(args.authorization, args.accountId, publicId);
  if (publicPolicies.length !== 1
    || !exactPolicy(
      publicPolicies[0],
      PUBLIC_POLICY_DESIRED,
      publicPolicyId,
    )) {
    throw new AccessConflictError("The Tiller public endpoint policy changed");
  }
  return actualExpiration;
}

export async function validateManagedAccess(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  resources: InstallationResourcesV1;
  ownerEmail: string;
}): Promise<void> {
  await validateManagedAccessState({ ...args, allowExpirationMismatch: false });
}

/**
 * Recovery read used only after an in-flight refresh alarm may have committed.
 * Every identity, destination, and policy is still exact; only the expiration
 * binding is allowed to lag until the Worker reconciliation upload.
 */
export function readManagedAccessExpiration(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  resources: InstallationResourcesV1;
  ownerEmail: string;
}): Promise<string> {
  return validateManagedAccessState({ ...args, allowExpirationMismatch: true });
}

/** Refreshes the existing service token in place; the client secret is unchanged. */
export async function renewManagedAccess(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  resources: InstallationResourcesV1;
  ownerEmail: string;
  mutate: AccessMutation;
}): Promise<InstallationResourcesV1> {
  await validateManagedAccess(args);
  const requestedAt = Date.now();
  const refreshed = await args.mutate(() => refreshAccessServiceToken(
    args.authorization,
    args.accountId,
    required(args.resources.accessServiceTokenId, "an Access service token ID"),
  ));
  if (refreshed.id?.trim() !== args.resources.accessServiceTokenId
    || refreshed.name !== `Tiller (${args.resources.installationId})`
    || refreshed.client_id?.trim() !== args.resources.accessServiceClientId) {
    throw new AccessConflictError("Cloudflare did not refresh the existing Tiller service token");
  }
  const resources = {
    ...args.resources,
    ownerEmail: args.ownerEmail,
    accessTokenExpiresAt: oneYearExpiration(refreshed.expires_at, requestedAt),
  };
  await validateManagedAccess({ ...args, resources });
  return resources;
}

/**
 * Reject deterministic Access conflicts before a fresh install creates any
 * customer resources. The Worker ID does not exist yet, so this check covers
 * hostname, wildcard, account-wide, and malformed destinations; exact Worker
 * destinations are checked again after the disabled Worker is created.
 */
export async function validateFreshAccessPreflight(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  workersDevHostname: string;
}): Promise<void> {
  const organization = await getAccessOrganization(args.authorization, args.accountId);
  if (!organization) return;
  accessIssuer(organization.auth_domain);

  const [providers, applications] = await Promise.all([
    listIdentityProviders(args.authorization, args.accountId),
    listAccessApplications(args.authorization, args.accountId),
  ]);
  if (providers.filter((provider) => restrictedIdp(provider)).length > 1) {
    throw new AccessConflictError("Account-member identity providers are ambiguous");
  }
  if (applications.some((application) => destinationCanConflict(
    application,
    "",
    args.workersDevHostname,
  ))) {
    throw new AccessConflictError(
      "Cloudflare Access already protects the Tiller workers.dev destination",
    );
  }
}

/** Advance at most one fresh Access resource per call. Existing install-owned resources are never adopted. */
export async function provisionFreshAccessStep(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  resources: InstallationResourcesV1;
  mutate: FreshAccessMutation;
}): Promise<FreshAccessStepResult> {
  const resources = { ...args.resources };
  let organization = await getAccessOrganization(args.authorization, args.accountId);
  if (!organization) {
    if (resources.accessIssuer || resources.accessOrganizationCreatedAt) {
      throw new AccessPropagationError();
    }
    const createdAt = Date.now();
    const teamLabel = accessTeamLabel(resources.workersDevHostname, resources.installationId);
    return args.mutate(async () => {
      const created = await createAccessOrganization(args.authorization, args.accountId, {
        name: "Tiller",
        auth_domain: `${teamLabel}.cloudflareaccess.com`,
      });
      const issuer = accessIssuer(created.auth_domain);
      if (issuer !== `https://${teamLabel}.cloudflareaccess.com`) {
        throw new Error("Cloudflare did not create the requested Zero Trust organization");
      }
      return {
        done: false,
        resources: {
          ...resources,
          accessIssuer: issuer,
          accessOrganizationCreatedAt: new Date(createdAt).toISOString(),
        },
      };
    });
  }
  const issuer = accessIssuer(organization.auth_domain);
  if (resources.accessIssuer && resources.accessIssuer !== issuer) {
    throw new AccessConflictError("The fresh Zero Trust organization changed");
  }
  resources.accessIssuer = issuer;

  const providers = await listIdentityProviders(args.authorization, args.accountId);
  if (resources.accessIdentityProviderId) {
    const recorded = providers.find((provider) => provider.id?.trim() === resources.accessIdentityProviderId);
    if (!recorded) throw new AccessPropagationError();
    if (!restrictedIdp(recorded, resources.accessIdentityProviderId)) {
      throw new AccessConflictError("The selected account-member identity provider changed");
    }
  } else {
    const restricted = providers.filter((provider) => restrictedIdp(provider));
    if (restricted.length > 1) throw new AccessConflictError("Account-member identity providers are ambiguous");
    if (restricted.length === 1) {
      resources.accessIdentityProviderId = required(restricted[0].id, "an Access identity provider ID");
      resources.accessOrganizationCreatedAt = undefined;
      return { done: false, resources };
    }
    const organizationCreatedAt = Date.parse(resources.accessOrganizationCreatedAt ?? "");
    if (Number.isFinite(organizationCreatedAt)) {
      throw new AccessPropagationError();
    }
    return args.mutate(async () => {
      const created = await createIdentityProvider(args.authorization, args.accountId);
      if (!restrictedIdp(created)) throw new Error("Cloudflare did not create a restricted identity provider");
      return {
        done: false,
        resources: {
          ...resources,
          accessIdentityProviderId: required(created.id, "an Access identity provider ID"),
        },
      };
    });
  }

  const tokenName = `Tiller (${resources.installationId})`;
  if (!resources.accessServiceTokenId) {
    if ((await listAccessServiceTokens(args.authorization, args.accountId)).some((token) => token.name === tokenName)) {
      throw new AccessConflictError("A Tiller service token with this fresh installation name already exists");
    }
    return args.mutate(async () => {
      const created = await createAccessServiceToken(args.authorization, args.accountId, tokenName);
      if (created.name !== tokenName) throw new Error("Cloudflare returned the wrong Access service token");
      return {
        done: false,
        resources: {
          ...resources,
          accessServiceTokenId: required(created.id, "an Access service token ID"),
          accessServiceClientId: required(created.client_id, "an Access service client ID"),
        },
        serviceClientSecret: required(created.client_secret, "an Access service client secret"),
      };
    });
  }
  const token = await getAccessServiceToken(args.authorization, args.accountId, resources.accessServiceTokenId);
  const actualExpiration = oneYearExpiration(token.expires_at, Date.now());
  if (token.id?.trim() !== resources.accessServiceTokenId
    || token.client_id?.trim() !== resources.accessServiceClientId
    || token.name !== tokenName) {
    throw new AccessConflictError("The fresh Access service token no longer matches this job");
  }
  if (!resources.accessTokenExpiresAt) {
    resources.accessTokenExpiresAt = actualExpiration;
    return { done: false, resources };
  }
  if (actualExpiration !== resources.accessTokenExpiresAt) {
    throw new AccessConflictError("The fresh Access service token no longer matches this job");
  }

  const workerId = required(resources.workerId, "the Worker ID");
  const applications = await listAccessApplications(args.authorization, args.accountId);
  const ownedIds = new Set([resources.accessApplicationId, resources.accessPublicApplicationId]
    .filter((value): value is string => Boolean(value)));
  if (applications.some((app) => !ownedIds.has(app.id?.trim() ?? "")
    && destinationCanConflict(app, workerId, resources.workersDevHostname))) {
    throw new AccessConflictError();
  }

  if (!resources.accessApplicationId) {
    return args.mutate(async () => {
      const created = await createAccessApplication(
        args.authorization,
        args.accountId,
        mainDesired(resources),
      );
      if (!exactWorkerApplication(created, {
        workerId,
        hostname: resources.workersDevHostname,
        idpId: required(resources.accessIdentityProviderId, "an identity provider ID"),
        installationId: resources.installationId,
      })) throw new Error("Cloudflare did not create the exact Tiller Access application");
      return {
        done: false,
        resources: {
          ...resources,
          accessApplicationId: required(created.id, "an Access application ID"),
          accessAudience: required(created.aud, "an Access audience"),
        },
      };
    });
  }
  const main = await getAccessApplication(args.authorization, args.accountId, resources.accessApplicationId);
  if (!exactWorkerApplication(main, {
    workerId,
    hostname: resources.workersDevHostname,
    idpId: required(resources.accessIdentityProviderId, "an identity provider ID"),
    installationId: resources.installationId,
  }) || main.aud?.trim() !== resources.accessAudience) {
    throw new AccessConflictError("The fresh Tiller Access application no longer matches this job");
  }

  const ownerPolicy = ownerPolicyDesired(resources.ownerEmail);
  const mainPolicies = await listAccessPolicies(args.authorization, args.accountId, resources.accessApplicationId);
  if (!resources.accessOwnerPolicyId) {
    if (mainPolicies.length !== 0) throw new AccessConflictError("The fresh Access application has an unexpected policy");
    return args.mutate(async () => {
      const created = await createAccessPolicy(
        args.authorization,
        args.accountId,
        resources.accessApplicationId!,
        ownerPolicy,
      );
      if (!exactPolicy(created, ownerPolicy)) {
        throw new Error("Cloudflare did not create the owner policy exactly");
      }
      return {
        done: false,
        resources: { ...resources, accessOwnerPolicyId: required(created.id, "an owner policy ID") },
      };
    });
  }
  const recordedOwnerPolicy = mainPolicies.find(
    (policy) => policy.id?.trim() === resources.accessOwnerPolicyId,
  );
  if (!recordedOwnerPolicy && mainPolicies.length === 0) throw new AccessPropagationError();
  if (!exactPolicy(recordedOwnerPolicy, ownerPolicy, resources.accessOwnerPolicyId)) {
    throw new AccessConflictError("The fresh Access owner policy no longer matches this job");
  }

  const servicePolicy = servicePolicyDesired(required(
    resources.accessServiceTokenId,
    "an Access service token ID",
  ));
  if (!resources.accessServicePolicyId) {
    if (mainPolicies.length !== 1) throw new AccessConflictError("The fresh Access application has an unexpected policy");
    return args.mutate(async () => {
      const created = await createAccessPolicy(
        args.authorization,
        args.accountId,
        resources.accessApplicationId!,
        servicePolicy,
      );
      if (!exactPolicy(created, servicePolicy)) {
        throw new Error("Cloudflare did not create the service policy exactly");
      }
      return {
        done: false,
        resources: { ...resources, accessServicePolicyId: required(created.id, "a service policy ID") },
      };
    });
  }
  const recordedServicePolicy = mainPolicies.find(
    (policy) => policy.id?.trim() === resources.accessServicePolicyId,
  );
  if (!recordedServicePolicy && mainPolicies.length === 1
    && exactPolicy(recordedOwnerPolicy, ownerPolicy, resources.accessOwnerPolicyId)) {
    throw new AccessPropagationError();
  }
  if (mainPolicies.length !== 2 || !exactPolicy(
    recordedServicePolicy,
    servicePolicy,
    resources.accessServicePolicyId,
  )) throw new AccessConflictError("The fresh Access service policy no longer matches this job");

  if (!resources.accessPublicApplicationId) {
    return args.mutate(async () => {
      const created = await createAccessApplication(
        args.authorization,
        args.accountId,
        publicDesired(resources),
      );
      if (!exactPublicApplication(created, resources.workersDevHostname, resources.installationId)) {
        throw new Error("Cloudflare did not create the exact public endpoint application");
      }
      return {
        done: false,
        resources: {
          ...resources,
          accessPublicApplicationId: required(created.id, "a public Access application ID"),
        },
      };
    });
  }
  const publicApp = await getAccessApplication(
    args.authorization,
    args.accountId,
    resources.accessPublicApplicationId,
  );
  if (!exactPublicApplication(publicApp, resources.workersDevHostname, resources.installationId)) {
    throw new AccessConflictError("The fresh public endpoint application no longer matches this job");
  }

  const publicPolicies = await listAccessPolicies(
    args.authorization,
    args.accountId,
    resources.accessPublicApplicationId,
  );
  if (!resources.accessPublicPolicyId) {
    if (publicPolicies.length !== 0) throw new AccessConflictError("The public endpoint application has an unexpected policy");
    return args.mutate(async () => {
      const created = await createAccessPolicy(
        args.authorization,
        args.accountId,
        resources.accessPublicApplicationId!,
        PUBLIC_POLICY_DESIRED,
      );
      if (!exactPolicy(created, PUBLIC_POLICY_DESIRED)) {
        throw new Error("Cloudflare did not create the bypass policy exactly");
      }
      return {
        done: false,
        resources: {
          ...resources,
          accessPublicPolicyId: required(created.id, "a bypass policy ID"),
        },
      };
    });
  }
  const recordedPublicPolicy = publicPolicies.find(
    (policy) => policy.id?.trim() === resources.accessPublicPolicyId,
  );
  if (!recordedPublicPolicy && publicPolicies.length === 0) throw new AccessPropagationError();
  if (publicPolicies.length !== 1 || !exactPolicy(
    recordedPublicPolicy,
    PUBLIC_POLICY_DESIRED,
    resources.accessPublicPolicyId,
  )) throw new AccessConflictError("The fresh public endpoint policy no longer matches this job");

  return { done: true, resources };
}
