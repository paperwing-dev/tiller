import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { productionReleaseDescriptorFixture } from "./release-fixture";
import app, {
  stableRelease,
  startDeployment,
  startMaintenance,
  submitDeployment,
} from "./index";
import type { Env, ReleaseDescriptorV1 } from "./types";

const stableDescriptorJson = productionReleaseDescriptorFixture();
const CONTAINER_PROGRESS_DETAIL = `Creating Containers (2 of ${stableDescriptorJson.containers.length})`;

function env(rateLimitSuccess = true): Env {
  return {
    PUBLIC_ORIGIN: "https://install.paperwing.dev",
    OAUTH_REDIRECT_URI: "https://install.paperwing.dev/oauth/callback",
    CLOUDFLARE_OAUTH_CLIENT_ID: "client",
    CLOUDFLARE_OAUTH_CLIENT_SECRET: "secret",
    INSTALLER_TOKEN_ENCRYPTION_KEY_V1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    INSTALL_START_LIMITER: { limit: vi.fn(async () => ({ success: rateLimitSuccess })) },
    INSTALL_JOB: { idFromName: vi.fn(() => { throw new Error("must not allocate"); }) },
  } as unknown as Env;
}

function promotedDescriptor(): ReleaseDescriptorV1 {
  return { ...(structuredClone(stableDescriptorJson) as ReleaseDescriptorV1), releaseId: "a".repeat(40) };
}

function developmentDescriptor(): ReleaseDescriptorV1 {
  return { ...promotedDescriptor(), releaseId: "0".repeat(40) };
}

function startApp(descriptor: ReleaseDescriptorV1) {
  const testApp = new Hono<{ Bindings: Env }>();
  testApp.get("/deploy", (c) => startDeployment(c, async () => descriptor));
  testApp.post("/deploy", (c) => submitDeployment(c, async () => descriptor));
  testApp.get("/maintenance", (c) => startMaintenance(c, async () => descriptor));
  testApp.get("/stable", (c) => stableRelease(c, async () => descriptor));
  return testApp;
}

function geoRequest(
  url: string,
  init: RequestInit = {},
  cf: Record<string, unknown> = { continent: "NA", longitude: "-122.4" },
): Request {
  const request = new Request(url, init);
  Object.defineProperty(request, "cf", { value: cf });
  return request;
}

function startBindings() {
  const jobFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
    Response.json({ authorizationUrl: "https://dash.cloudflare.com/oauth2/auth" })
  ));
  const bindings = env();
  bindings.INSTALL_JOB = {
    idFromName: vi.fn(() => "job-do-id"),
    get: vi.fn(() => ({ fetch: jobFetch })),
  } as unknown as DurableObjectNamespace;
  return { bindings, jobFetch };
}

describe("fresh installer routes", () => {
  it("exposes only release verification on workers.dev", async () => {
    const bindings = env();
    const verification = await app.request(
      "https://paperwing-tiller-installer.personal-infrastructure.workers.dev/stable",
      undefined,
      bindings,
    );
    const deployment = await app.request(
      "https://paperwing-tiller-installer.personal-infrastructure.workers.dev/deploy",
      undefined,
      bindings,
    );

    expect(verification.status).toBe(503);
    expect(deployment.status).toBe(404);
    await expect(deployment.json()).resolves.toEqual({ error: "not_found" });
    expect(bindings.INSTALL_JOB.idFromName).not.toHaveBeenCalled();
  });

  it("rate limits before allocating job state", async () => {
    const bindings = env(false);
    const response = await app.request(geoRequest("https://install.paperwing.dev/deploy", {
      headers: { "CF-Connecting-IP": "203.0.113.10" },
    }), undefined, bindings);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(bindings.INSTALL_JOB.idFromName).not.toHaveBeenCalled();
  });

  it("does not allocate while the descriptor is the development sentinel", async () => {
    const bindings = env();
    const response = await startApp(developmentDescriptor()).request(geoRequest("https://install.paperwing.dev/deploy", {
      headers: { "CF-Connecting-IP": "203.0.113.10" },
    }), undefined, bindings);
    expect(response.status).toBe(503);
    expect(bindings.INSTALL_JOB.idFromName).not.toHaveBeenCalled();
  });

  it("redirects immediately to OAuth with a secure 30-minute session", async () => {
    const { bindings, jobFetch } = startBindings();
    const response = await startApp(promotedDescriptor()).request(
      geoRequest("https://install.paperwing.dev/deploy", {
        headers: { "CF-Connecting-IP": "203.0.113.10" },
      }),
      undefined,
      bindings,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(response.headers.get("Set-Cookie")).toMatch(/Max-Age=1800; Secure; HttpOnly; SameSite=Lax/);
    const init = jobFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      intent: "install",
      placementRegion: "wnam",
      descriptor: { releaseId: "a".repeat(40) },
    });
  });

  it("renders a stateless selector when request location inference fails", async () => {
    const bindings = env();
    const loader = vi.fn(async () => promotedDescriptor());
    const testApp = new Hono<{ Bindings: Env }>();
    testApp.get("/deploy", (c) => startDeployment(c, loader));
    const response = await testApp.request(
      geoRequest("https://install.paperwing.dev/deploy", {}, {
        continent: "NA",
        longitude: "not-a-longitude",
      }),
      undefined,
      bindings,
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<form method="post" action="/deploy">');
    expect(html).toContain('<option value="wnam">Western North America (WNAM)</option>');
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(loader).not.toHaveBeenCalled();
    expect(bindings.INSTALL_START_LIMITER.limit).not.toHaveBeenCalled();
    expect(bindings.INSTALL_JOB.idFromName).not.toHaveBeenCalled();
  });

  it("accepts one same-origin form region and preserves it in the job handoff", async () => {
    const { bindings, jobFetch } = startBindings();
    const response = await startApp(promotedDescriptor()).request(
      "https://install.paperwing.dev/deploy",
      {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.10",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Origin: "https://install.paperwing.dev",
        },
        body: "region=weur",
      },
      bindings,
    );
    expect(response.status).toBe(302);
    const init = jobFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      intent: "install",
      placementRegion: "weur",
    });
  });

  it.each([
    ["query parameters", "https://install.paperwing.dev/deploy?x=1", "region=wnam", {
      Origin: "https://install.paperwing.dev",
      "Content-Type": "application/x-www-form-urlencoded",
    }, 400],
    ["a cross-origin request", "https://install.paperwing.dev/deploy", "region=wnam", {
      Origin: "https://attacker.example",
      "Content-Type": "application/x-www-form-urlencoded",
    }, 403],
    ["the wrong content type", "https://install.paperwing.dev/deploy", "region=wnam", {
      Origin: "https://install.paperwing.dev",
      "Content-Type": "application/json",
    }, 415],
    ["an unknown region", "https://install.paperwing.dev/deploy", "region=texas", {
      Origin: "https://install.paperwing.dev",
      "Content-Type": "application/x-www-form-urlencoded",
    }, 400],
    ["a duplicate region", "https://install.paperwing.dev/deploy", "region=wnam&region=enam", {
      Origin: "https://install.paperwing.dev",
      "Content-Type": "application/x-www-form-urlencoded",
    }, 400],
    ["an extra field", "https://install.paperwing.dev/deploy", "region=wnam&next=oauth", {
      Origin: "https://install.paperwing.dev",
      "Content-Type": "application/x-www-form-urlencoded",
    }, 400],
  ])("rejects %s before lifecycle allocation", async (_case, url, body, headers, status) => {
    const { bindings } = startBindings();
    const response = await startApp(promotedDescriptor()).request(url, {
      method: "POST",
      headers,
      body,
    }, bindings);
    expect(response.status).toBe(status);
    expect(bindings.INSTALL_START_LIMITER.limit).not.toHaveBeenCalled();
    expect(bindings.INSTALL_JOB.idFromName).not.toHaveBeenCalled();
  });

  it("rejects every deploy query before rate limiting or allocation", async () => {
    const { bindings } = startBindings();
    const response = await startApp(promotedDescriptor()).request(
      "https://install.paperwing.dev/deploy?releaseId=attacker",
      { headers: { "CF-Connecting-IP": "203.0.113.10" } },
      bindings,
    );
    expect(response.status).toBe(400);
    expect(bindings.INSTALL_START_LIMITER.limit).not.toHaveBeenCalled();
    expect(bindings.INSTALL_JOB.idFromName).not.toHaveBeenCalled();
  });

  it("accepts only the non-authoritative update or renew maintenance intent", async () => {
    const { bindings, jobFetch } = startBindings();
    const accepted = await startApp(promotedDescriptor()).request(
      "https://install.paperwing.dev/maintenance?intent=renew",
      { headers: { "CF-Connecting-IP": "203.0.113.10" } },
      bindings,
    );
    expect(accepted.status).toBe(302);
    const init = jobFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ intent: "renew" });

    for (const query of ["", "?intent=install", "?intent=update&account=attacker"]) {
      expect((await startApp(promotedDescriptor()).request(
        `https://install.paperwing.dev/maintenance${query}`,
        {},
        env(),
      )).status).toBe(400);
    }
  });

  it("does not announce the development release through stable", async () => {
    const response = await startApp(developmentDescriptor()).request(
      "https://install.paperwing.dev/stable",
      {},
      env(),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "stable_release_unavailable" });
  });

  it("exposes only the stable release summary", async () => {
    const release = promotedDescriptor();
    const response = await startApp(release).request("https://install.paperwing.dev/stable", {}, env());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Cache-Control")).not.toContain("s-maxage");
    await expect(response.json()).resolves.toEqual({
      releaseId: release.releaseId,
      version: release.version,
      releaseNotesUrl: release.releaseNotesUrl,
    });
  });

  it.each([
    {
      intent: "install",
      heading: "Deploying Tiller",
      context: "Preparing a new Hub in your Cloudflare account.",
      middleStage: "Deploying your Hub",
      operation: "deployment",
    },
    {
      intent: "update",
      heading: "Updating Tiller",
      context: "Checking and updating your existing Hub.",
      middleStage: "Updating your Hub",
      operation: "update",
    },
    {
      intent: "renew",
      heading: "Renewing Tiller access",
      context: "Renewing Cloudflare Access and bringing your Hub up to date.",
      middleStage: "Renewing and verifying your Hub",
      operation: "access renewal",
    },
  ] as const)("renders intent-specific $intent progress copy", async ({
    intent,
    heading,
    context,
    middleStage,
    operation,
  }) => {
    const response = await app.request(
      `https://install.paperwing.dev/jobs/${"a".repeat(43)}?intent=${intent}`,
      { headers: { Cookie: "__Host-tiller_install_session=session" } },
      env(),
    );
    const html = await response.text();
    expect(html).toContain(`<title>${heading}</title>`);
    expect(html).toContain(`<h1 id="heading">${heading}</h1>`);
    expect(html).toContain(`<p id="context">${context}</p>`);
    expect(html).toContain(`<span class="stage-label">${middleStage}</span>`);
    expect(html).toContain(`"${intent}":${JSON.stringify({
      heading,
      context,
      middleStage,
      operation,
    })}`);
    expect(html).toContain("Your Hub runs in your Cloudflare account. paperwing.dev is only used to manage installation and updates.");
    expect(html).not.toContain('<p class="brand">');
    expect(html).toContain("Connecting Cloudflare");
    expect(html).toContain("Opening your Hub");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("keeps the three-stage page mechanics while applying authoritative intent safely", async () => {
    const response = await app.request(`https://install.paperwing.dev/jobs/${"a".repeat(43)}?intent=install`, {
      headers: { Cookie: "__Host-tiller_install_session=session" },
    }, env());
    const html = await response.text();
    expect(html).toContain("access-destination-conflict");
    expect(html).toContain("Open Cloudflare Access");
    expect(html).toContain("container-registry-repair-required");
    expect(html).toContain("Start again after repair");
    expect(html).toContain("npx wrangler containers registries delete docker.io");
    expect(html).toContain("Public Tiller images need no Docker credentials");
    expect(html).not.toContain("containers registries configure docker.io");
    expect(html).toContain("container-registry-unavailable");
    expect(html).toContain("Cloudflare could not verify Container image access. No Tiller resources were created, so it is safe to try again.");
    expect(html).toContain('status.issue==="container-registry-unavailable"');
    expect(html).toContain('link.textContent="Try installation again"');
    expect(html).toContain("installation-restart-required");
    expect(html).toContain("If you already removed its partial Tiller resources, no more cleanup is needed.");
    expect(html).toContain('status.nextAction.kind==="start-fresh"?"Start fresh installation":"Authorize Cloudflare"');
    expect(html).toContain("manual-cleanup-required");
    expect(html).toContain("color-scheme:light");
    expect(html).toContain("--paper:#fbf4ed;--ink:#152c49");
    expect(html).toContain("main{width:min(500px,calc(100% - 40px));margin:0 auto;padding:clamp(48px,12vh,112px) 0 64px}");
    expect(html).toContain('<ol aria-label="Tiller progress">');
    expect(html).toContain('data-state="active" aria-current="step"');
    expect(html).toContain('class="stage-detail" role="status" aria-live="polite"');
    expect(html).toContain('function setText(element,value){if(element.textContent!==value)element.textContent=value}');
    expect(html).toContain('function applyIntent(value){if(value!=="install"&&value!=="update"&&value!=="renew")return;');
    expect(html).toContain('if(status&&typeof status==="object")applyIntent(status.intent)');
    expect(html).toContain('function setProgressMessage(detail)');
    expect(html).toContain('typeof detail==="string"?detail.trim():""');
    expect(html).toContain('setText(message,value)');
    expect(html).toContain('function reassuranceMessage(){return "You can close this tab. The "+progressCopy[currentIntent].operation+" will continue in Cloudflare."}');
    expect(html).toContain('setText(reassurance,reassuranceMessage())');
    expect(html).toContain('function actionMessage(status){const detail=typeof status.detail==="string"&&status.detail.length<=2048?status.detail.trim():"";');
    expect(html).toContain('document.createTextNode(actionMessage(status))');
    expect(html).toContain('if(message.parentElement!==target)target.append(message)');
    expect(html).toContain('function showReassurance(value){reassurance.hidden=!value}');
    expect(html).toContain('render("completed");showReassurance(false)');
    expect(html).toContain('function attentionMessage(){return "Cloudflare needs your attention before the "+progressCopy[currentIntent].operation+" can continue. "}');
    expect(html).toContain('function reconnectMessage(){return "Waiting to reconnect to the "+progressCopy[currentIntent].operation+"…"}');
    expect(html).toContain('setProgressMessage(status.detail)');
    expect(html).not.toContain("#080b13");
    expect(html).not.toContain("#e7ad49");
    expect(html).not.toContain("innerHTML");
    expect(html).not.toMatch(/<link[^>]+(?:stylesheet|font)/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
  });

  it("offers the matching OAuth restart when a maintenance browser session expires", async () => {
    const response = await app.request(
      `https://install.paperwing.dev/jobs/${"a".repeat(43)}?intent=renew`,
      { headers: { Cookie: "__Host-tiller_install_session=session" } },
      env(),
    );
    const html = await response.text();
    expect(html).toContain('const initialIntent="renew"');
    expect(html).toContain('function restartUrl(){return currentIntent==="install"?"/deploy":"/maintenance?intent="+encodeURIComponent(currentIntent)}');
    expect(html).toContain("link.href=restartUrl()");
    expect(html).toContain("browser authorization expired");
    expect(html).not.toContain('response.status===404){message.replaceChildren(document.createTextNode(issues["manual-cleanup-required"]');
  });

  it("returns an accepted callback to the one deployment progress page", async () => {
    const jobId = "a".repeat(43);
    const bindings = env();
    bindings.INSTALL_JOB = {
      idFromName: vi.fn(() => "job-do-id"),
      get: vi.fn(() => ({ fetch: vi.fn(async () => Response.json({ accepted: true, intent: "renew" })) })),
    } as unknown as DurableObjectNamespace;
    const response = await app.request(
      `https://install.paperwing.dev/oauth/callback?state=${jobId}.state&code=code`,
      { headers: { Cookie: "__Host-tiller_install_session=session" } },
      bindings,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`https://install.paperwing.dev/jobs/${jobId}?intent=renew`);
  });

  it("forwards only the session-bound status projection", async () => {
    const bindings = env();
    bindings.INSTALL_JOB = {
      idFromName: vi.fn(() => "job-do-id"),
      get: vi.fn(() => ({ fetch: vi.fn(async () => Response.json({
        stage: "deploy-tiller",
        detail: CONTAINER_PROGRESS_DETAIL,
        intent: "update",
      })) })),
    } as unknown as DurableObjectNamespace;
    const response = await app.request(
      `https://install.paperwing.dev/jobs/${"a".repeat(43)}/status`,
      { headers: { Cookie: "__Host-tiller_install_session=session" } },
      bindings,
    );
    await expect(response.json()).resolves.toEqual({
      stage: "deploy-tiller",
      detail: CONTAINER_PROGRESS_DETAIL,
      intent: "update",
    });
  });
});
