export type LifecycleIntent = "install" | "update" | "renew";

export type { PlacementRegion } from "../../hub/shared/placement";

import type { PlacementRegion } from "../../hub/shared/placement";

export type VisibleLifecycleStage = "connect-cloudflare" | "deploy-tiller" | "open-hub";

export interface StableReleaseSummary {
  releaseId: string;
  version: string;
  releaseNotesUrl: string;
}

export type {
  FixedContainerV1,
  InstallerRuntimeBindingKey,
  ReleaseDescriptorV1,
  RuntimeBindingSlot,
  WorkerUploadBindingV1,
  WorkerUploadExportV1,
  WorkerUploadTemplateV1,
} from "./release-contract";

import type { ReleaseDescriptorV1 } from "./release-contract";

export type LifecycleIssue =
  | "workers-paid-required"
  | "containers-required"
  | "workers-dev-required"
  | "single-account-required"
  | "foreign-worker-conflict"
  | "access-destination-conflict"
  | "container-registry-repair-required"
  | "container-registry-unavailable"
  | "installation-restart-required"
  | "manual-cleanup-required"
  | "reauthorization-required"
  | "access-repair-required"
  | "topology-drift";

export type InstallIssue = LifecycleIssue;

export type JobProjection =
  | { stage: "authorize"; nextAction: { kind: "authorize"; url: string } }
  | { stage: VisibleLifecycleStage }
  | {
      stage: "action-required";
      issue: LifecycleIssue;
      /** A bounded, user-safe explanation for this specific operation failure. */
      detail?: string;
      nextAction?:
        | { kind: "reauthorize"; url: string }
        | { kind: "start-fresh"; url: string };
    }
  | { stage: "completed"; hubUrl: string }
  | { stage: "failed"; error: { code: string; message: string } };

export interface Env {
  INSTALL_JOB: DurableObjectNamespace;
  ACCOUNT_LIFECYCLE: DurableObjectNamespace;
  INSTALL_START_LIMITER: RateLimit;
  CLOUDFLARE_OAUTH_CLIENT_ID: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET: string;
  INSTALLER_TOKEN_ENCRYPTION_KEY_V1: string;
  PUBLIC_ORIGIN: string;
  OAUTH_REDIRECT_URI: string;
}

export interface OAuthAttemptV1 {
  state: string;
  verifier: string;
  expiresAt: string;
  consumed: boolean;
}

export interface EncryptedTokenV1 {
  version: 1;
  iv: string;
  ciphertext: string;
  expiresAt: string;
}

export type EncryptedAccessSecretV1 = EncryptedTokenV1;

export interface InstallationResourcesV1 {
  installationId: string;
  ownerEmail: string;
  workersDevHostname: string;
  workerId?: string;
  kvNamespaceId?: string;
  r2BucketName?: string;
  accessOrganizationCreatedAt?: string;
  accessIdentityProviderId?: string;
  accessServiceTokenId?: string;
  accessServiceClientId?: string;
  accessTokenExpiresAt?: string;
  accessIssuer?: string;
  accessApplicationId?: string;
  accessAudience?: string;
  accessOwnerPolicyId?: string;
  accessServicePolicyId?: string;
  accessPublicApplicationId?: string;
  accessPublicPolicyId?: string;
  durableObjectNamespaceIds?: Record<string, string>;
  containerApplications?: Record<string, { id: string; name: string }>;
}

export interface InstallationResourceIdentityV1 {
  ownerEmail: string;
  workersDevHostname: string;
  kvNamespaceId: string;
  r2BucketName: string;
  accessIdentityProviderId: string;
  accessServiceTokenId: string;
  accessServiceClientId: string;
  accessIssuer: string;
  accessApplicationId: string;
  accessAudience: string;
  accessOwnerPolicyId: string;
  accessServicePolicyId: string;
  accessPublicApplicationId: string;
  accessPublicPolicyId: string;
  durableObjectNamespaceIds: Record<string, string>;
  containerApplications: Record<string, { id: string; name: string }>;
}

export interface InstallationAnchorV1 {
  schemaVersion: 1;
  installationId: string;
  workerId: string;
  placementRegion: PlacementRegion;
  resourceIdentity: InstallationResourceIdentityV1;
  /** Last Access service-token expiration proven by Cloudflare readback. */
  accessTokenExpiresAt: string;
  /** Last Container image set proven through completed rollouts and Hub probes. */
  containerImages: Record<string, string>;
}

export type InstallStep =
  | "authorize"
  | "preflight"
  | "ensure-container-registry"
  | "create-worker"
  | "create-kv"
  | "create-r2"
  | "access"
  | "upload-worker"
  | "verify-worker"
  | "containers"
  | "enable-worker"
  | "health-probe"
  | "unauthenticated-probe"
  | "service-probe"
  | "revoke"
  | "completed"
  | "failed";

export type MaintenanceStep =
  | "maintenance-readback"
  | "maintenance-renew-access"
  | "maintenance-upload-worker"
  | "maintenance-verify-worker"
  | "maintenance-container-patch"
  | "maintenance-container-rollout"
  | "maintenance-container-wait"
  | "maintenance-probe"
  | "revoke"
  | "completed"
  | "failed";

export interface ContainerCursorV1 {
  index: number;
  applicationId?: string;
  rolloutId?: string;
  readyInstances?: number;
  totalInstances?: number;
}

export interface InstallJobRecordV1 {
  jobId: string;
  browserSessionSha256: string;
  expiresAt: string;
  intent: LifecycleIntent;
  placementRegion?: PlacementRegion;
  descriptor: ReleaseDescriptorV1;
  projection: JobProjection;
  step: "authorize" | "attach" | "attached" | "failed";
  oauthAttempt?: OAuthAttemptV1;
  encryptedToken?: EncryptedTokenV1;
  accountId?: string;
  operationId?: string;
}

export interface AccountOperationRecordV1 {
  operationId: string;
  accountId: string;
  intent: LifecycleIntent;
  placementRegion?: PlacementRegion;
  descriptor: ReleaseDescriptorV1;
  projection: JobProjection;
  step: InstallStep | MaintenanceStep;
  resources?: InstallationResourcesV1;
  freshMutationPending?: true;
  mutation?: true;
  sourceVersionId?: string;
  containerCursor?: ContainerCursorV1;
}
