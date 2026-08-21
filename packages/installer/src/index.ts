import { Hono, type Context } from "hono";
import stableDescriptorJson from "../stable-release.generated.json";
import { AccountLifecycleDO } from "./account-do";
import { randomBase64Url } from "./crypto";
import { InstallJobDO } from "./job-do";
import { parseReleaseDescriptor } from "./release";
import {
  inferPlacementRegion,
  isPlacementRegion,
  PLACEMENT_REGIONS,
  placementRegionDefinition,
} from "../../hub/shared/placement";
import type {
  Env,
  LifecycleIntent,
  PlacementRegion,
  ReleaseDescriptorV1,
} from "./types";

const SESSION_COOKIE = "__Host-tiller_install_session";
const JOB_ID = /^[A-Za-z0-9_-]{32,128}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{32,128}$/;
const START_RETRY_SECONDS = 60;

type AppEnv = { Bindings: Env };
type DescriptorLoader = () => Promise<ReleaseDescriptorV1>;

interface ProgressCopy {
  heading: string;
  context: string;
  middleStage: string;
  operation: string;
}

const PROGRESS_COPY = {
  install: {
    heading: "Deploying Tiller",
    context: "Preparing a new Hub in your Cloudflare account.",
    middleStage: "Deploying your Hub",
    operation: "deployment",
  },
  update: {
    heading: "Updating Tiller",
    context: "Checking and updating your existing Hub.",
    middleStage: "Updating your Hub",
    operation: "update",
  },
  renew: {
    heading: "Renewing Tiller access",
    context: "Renewing Cloudflare Access and bringing your Hub up to date.",
    middleStage: "Renewing and verifying your Hub",
    operation: "access renewal",
  },
} satisfies Record<LifecycleIntent, ProgressCopy>;

let descriptorPromise: Promise<ReleaseDescriptorV1> | undefined;

async function pinnedDescriptor(): Promise<ReleaseDescriptorV1> {
  descriptorPromise ??= Promise.resolve(parseReleaseDescriptor(stableDescriptorJson));
  return descriptorPromise;
}

function publicOrigin(env: Env): string {
  const raw = env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  if (raw !== "https://install.paperwing.dev") throw new Error("Installer public origin is invalid");
  return raw;
}

function noStore(c: Context<AppEnv>): void {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
}

function cookieValue(request: Request, name: string): string {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=Lax`;
}

function validJobId(value: string): string | null {
  const normalized = value.trim();
  return JOB_ID.test(normalized) ? normalized : null;
}

function callbackJobId(state: string): string | null {
  const separator = state.indexOf(".");
  return separator > 0 ? validJobId(state.slice(0, separator)) : null;
}

function lifecycleIntentParam(value: unknown): LifecycleIntent | null {
  return value === "install" || value === "update" || value === "renew" ? value : null;
}

function jobStub(env: Env, jobId: string): DurableObjectStub {
  return env.INSTALL_JOB.get(env.INSTALL_JOB.idFromName(jobId));
}

function internalFetch(
  env: Env,
  jobId: string,
  path: string,
  session: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Tiller-Browser-Session", session);
  return jobStub(env, jobId).fetch(`https://install-job.internal${path}`, { ...init, headers });
}

async function admitStart(c: Context<AppEnv>): Promise<boolean> {
  const address = c.req.header("CF-Connecting-IP")?.trim() || "unknown";
  try {
    return (await c.env.INSTALL_START_LIMITER.limit({ key: `install-start:v1:${address}` })).success;
  } catch {
    return false;
  }
}

async function startLifecycle(
  c: Context<AppEnv>,
  intent: LifecycleIntent,
  loadDescriptor: DescriptorLoader = pinnedDescriptor,
  placementRegion?: PlacementRegion,
): Promise<Response> {
  noStore(c);
  // Admission happens before a Durable Object ID is allocated or release data
  // is loaded, so abusive starts cannot allocate unbounded job state.
  if (!await admitStart(c)) {
    c.header("Retry-After", String(START_RETRY_SECONDS));
    return c.text("Tiller deployment is temporarily busy. Please try again shortly.", 503);
  }
  const descriptor = await loadDescriptor();
  if (/^0{40}$/.test(descriptor.releaseId)) {
    return c.text("No Tiller release is pinned to this installer.", 503);
  }
  const jobId = randomBase64Url(32);
  const existing = cookieValue(c.req.raw, SESSION_COOKIE);
  const session = SESSION_ID.test(existing) ? existing : randomBase64Url(32);
  const response = await internalFetch(c.env, jobId, "/create", session, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobId,
      descriptor,
      intent,
      ...(placementRegion ? { placementRegion } : {}),
    }),
  });
  const value = await response.json<{ authorizationUrl?: unknown }>()
    .catch((): { authorizationUrl?: unknown } => ({}));
  if (!response.ok || typeof value.authorizationUrl !== "string") {
    return c.text("Tiller deployment could not start.", 503);
  }
  c.header("Set-Cookie", sessionCookie(session));
  return c.redirect(value.authorizationUrl, 302);
}

export async function startDeployment(
  c: Context<AppEnv>,
  loadDescriptor: DescriptorLoader = pinnedDescriptor,
): Promise<Response> {
  if (new URL(c.req.url).searchParams.size !== 0) {
    noStore(c);
    return c.text("Unsupported deployment parameters.", 400);
  }
  const placementRegion = inferPlacementRegion(c.req.raw.cf);
  if (!placementRegion) return selectDeploymentRegion(c);
  return startLifecycle(c, "install", loadDescriptor, placementRegion);
}

export async function submitDeployment(
  c: Context<AppEnv>,
  loadDescriptor: DescriptorLoader = pinnedDescriptor,
): Promise<Response> {
  noStore(c);
  if (new URL(c.req.url).searchParams.size !== 0) {
    return c.text("Unsupported deployment parameters.", 400);
  }
  if (c.req.header("Origin") !== publicOrigin(c.env)) {
    return c.text("Deployment form origin is invalid.", 403);
  }
  const contentType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return c.text("Deployment form content type is invalid.", 415);
  }
  const declaredLength = Number(c.req.header("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 1_024) {
    return c.text("Deployment form is invalid.", 400);
  }
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > 1_024) {
    return c.text("Deployment form is invalid.", 400);
  }
  const form = new URLSearchParams(raw);
  const regions = form.getAll("region");
  if (form.size !== 1 || regions.length !== 1 || !isPlacementRegion(regions[0])) {
    return c.text("Deployment region is invalid.", 400);
  }
  return startLifecycle(c, "install", loadDescriptor, regions[0]);
}

export async function startMaintenance(
  c: Context<AppEnv>,
  loadDescriptor: DescriptorLoader = pinnedDescriptor,
): Promise<Response> {
  const params = new URL(c.req.url).searchParams;
  const intent = params.get("intent");
  if (params.size !== 1 || (intent !== "update" && intent !== "renew")) {
    noStore(c);
    return c.text("Unsupported maintenance parameters.", 400);
  }
  return startLifecycle(c, intent, loadDescriptor);
}

export async function stableRelease(
  c: Context<AppEnv>,
  loadDescriptor: DescriptorLoader = pinnedDescriptor,
): Promise<Response> {
  const descriptor = await loadDescriptor();
  if (/^0{40}$/.test(descriptor.releaseId)) {
    noStore(c);
    return c.json({ error: "stable_release_unavailable" }, 503);
  }
  noStore(c);
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  return c.json({
    releaseId: descriptor.releaseId,
    version: descriptor.version,
    releaseNotesUrl: descriptor.releaseNotesUrl,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function safeScriptJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Script value is not serializable");
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function selectDeploymentRegion(c: Context<AppEnv>): Response {
  noStore(c);
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  const options = PLACEMENT_REGIONS.map((region) => {
    const definition = placementRegionDefinition(region);
    return `<option value="${escapeHtml(region)}">${escapeHtml(definition.label)} (${escapeHtml(definition.code)})</option>`;
  }).join("");
  return c.html(`<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>Choose an installation region</title>
  <style>
    :root{color-scheme:light;font-family:"EB Garamond",Georgia,"Times New Roman",serif;background:#fbf4ed;color:#152c49}*{box-sizing:border-box}body{min-height:100vh;margin:0;background:#fbf4ed;color:#152c49}main{width:min(500px,calc(100% - 40px));margin:0 auto;padding:clamp(48px,12vh,112px) 0 64px}h1{margin:0 0 12px;font-size:clamp(2.25rem,7vw,2.75rem);font-weight:400;line-height:1.12}p{margin:0 0 28px;font-size:17px;line-height:1.55}label{display:block;margin-bottom:8px;font-size:15px;font-weight:600}select,button{width:100%;border:1px solid #152c49;border-radius:4px;font:inherit}select{padding:11px 12px;background:#fff;color:#152c49}button{margin-top:16px;padding:11px 14px;background:#152c49;color:#fbf4ed;font-weight:600;cursor:pointer}select:focus-visible,button:focus-visible{outline:2px solid #152c49;outline-offset:3px}
  </style>
</head><body><main>
  <h1>Choose an installation region</h1>
  <p>Cloudflare could not infer your location. Choose where Tiller should create its regional data and workloads.</p>
  <form method="post" action="/deploy">
    <label for="region">Installation region</label>
    <select id="region" name="region" required>${options}</select>
    <button type="submit">Continue to Cloudflare</button>
  </form>
</main></body></html>`);
}

function progressHtml(jobId: string, nonce: string, intent: LifecycleIntent): string {
  const safeJobId = escapeHtml(jobId);
  const initialCopy = PROGRESS_COPY[intent];
  const initialReassurance = `You can close this tab. The ${initialCopy.operation} will continue in Cloudflare.`;
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>${escapeHtml(initialCopy.heading)}</title>
  <style>
    :root{color-scheme:light;font-family:"EB Garamond",Georgia,"Times New Roman",serif;background:#fbf4ed;color:#152c49;--paper:#fbf4ed;--ink:#152c49;--ink-secondary:rgba(21,44,73,.68);--ink-muted:rgba(21,44,73,.68);--ink-pending:rgba(21,44,73,.68);--line:rgba(21,44,73,.18);--wash:rgba(21,44,73,.07)}
    *{box-sizing:border-box}html,body{min-height:100%;background:var(--paper)}body{min-height:100vh;min-height:100dvh;margin:0;color:var(--ink);font-synthesis:none}
    main{width:min(500px,calc(100% - 40px));margin:0 auto;padding:clamp(48px,12vh,112px) 0 64px}
    h1{margin:0 0 10px;color:var(--ink);font-size:clamp(2.25rem,7vw,2.75rem);font-weight:400;letter-spacing:0;line-height:1.12}
    #context{max-width:440px;margin:0;color:var(--ink);font-size:18px;line-height:1.5}
    #trust-note{max-width:430px;margin:16px 0 40px;color:var(--ink-secondary);font-size:15px;line-height:1.55}
    ol{list-style:none;margin:0;padding:0}li{position:relative;min-height:54px;padding:0 0 28px 38px;color:var(--ink-pending);font-size:17px;line-height:1.4;transition:color .25s ease}li:last-child{min-height:0;padding-bottom:0}
    li::before{position:absolute;top:.38em;left:0;z-index:1;width:12px;height:12px;border:1.5px solid currentColor;border-radius:50%;background:var(--paper);box-shadow:0 0 0 4px var(--paper);content:""}
    li:not(:last-child)::after{position:absolute;top:20px;bottom:0;left:6px;width:1px;background:var(--line);content:""}
    li[data-state="done"]{color:var(--ink-secondary)}li[data-state="done"]::before{top:.2em;border:0;background:var(--paper);color:var(--ink);content:"✓";font-family:Georgia,"Times New Roman",serif;font-size:15px;line-height:1}
    li[data-state="done"]::after{background:rgba(21,44,73,.42)}li[data-state="active"]{color:var(--ink)}li[data-state="active"]::before{border-color:var(--ink);background:var(--ink);box-shadow:0 0 0 5px var(--wash);animation:stage-pulse 1.8s ease-in-out infinite}
    .stage-label{display:block;font-weight:400}.stage-detail{min-height:1.5em;margin:6px 0 0;color:var(--ink-secondary);font-size:15px;line-height:1.5}
    #reassurance{width:calc(100% - 38px);max-width:390px;margin:28px 0 0 38px;color:var(--ink-muted);font-size:14px;line-height:1.55}#reassurance[hidden]{display:none}
    a{display:table;margin-top:14px;padding:9px 14px;border:1px solid var(--ink);border-radius:4px;background:var(--ink);color:var(--paper);font-family:inherit;font-size:15px;font-weight:600;line-height:1.25;text-decoration:none;transition:background .2s ease}a:hover{background:#0f2239}a:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
    @keyframes stage-pulse{0%,100%{box-shadow:0 0 0 4px var(--wash)}50%{box-shadow:0 0 0 7px var(--wash)}}
    @media (prefers-reduced-motion:reduce){li,a{transition:none}li[data-state="active"]::before{animation:none}}
    @media (max-width:520px){main{width:min(500px,calc(100% - 32px));padding:clamp(40px,8vh,64px) 0 48px}h1{font-size:2.25rem}#trust-note{margin-bottom:36px}}
  </style>
</head><body><main>
  <header><h1 id="heading">${escapeHtml(initialCopy.heading)}</h1><p id="context">${escapeHtml(initialCopy.context)}</p><p id="trust-note">Your Hub runs in your Cloudflare account. paperwing.dev is only used to manage installation and updates.</p></header>
  <ol aria-label="Tiller progress"><li id="connect-cloudflare" data-state="active" aria-current="step"><span class="stage-label">Connecting Cloudflare</span><p id="message" class="stage-detail" role="status" aria-live="polite"></p></li><li id="deploy-tiller" data-state="pending"><span class="stage-label">${escapeHtml(initialCopy.middleStage)}</span></li><li id="open-hub" data-state="pending"><span class="stage-label">Opening your Hub</span></li></ol>
  <p id="reassurance">${escapeHtml(initialReassurance)}</p>
</main><script nonce="${nonce}">
  const jobId=${safeScriptJson(safeJobId)};
  const initialIntent=${safeScriptJson(intent)};
  const progressCopy=${safeScriptJson(PROGRESS_COPY)};
  let currentIntent=initialIntent;
  const order=["connect-cloudflare","deploy-tiller","open-hub"];
  const heading=document.getElementById("heading");
  const context=document.getElementById("context");
  const middleStage=document.getElementById("deploy-tiller");
  const message=document.getElementById("message");
  const reassurance=document.getElementById("reassurance");
  const issues={
    "workers-paid-required":"Enable Workers Paid in this Cloudflare account, then start again. ",
    "containers-required":"Enable Cloudflare Containers in this account, then start again. ",
    "workers-dev-required":"Create this account's workers.dev subdomain in Cloudflare, then start again. ",
    "single-account-required":"Authorize exactly one Cloudflare account, then start again. ",
    "foreign-worker-conflict":"A Worker named tiller already exists. This installer never adopts or overwrites it. ",
    "access-destination-conflict":"Cloudflare Access already protects this Tiller workers.dev address. Remove the old Tiller Access applications, then start again. ",
    "container-registry-repair-required":"This account has an obsolete public docker.io registry record from an earlier Tiller attempt. Run npx wrangler containers registries delete docker.io, then start again. Public Tiller images need no Docker credentials. ",
    "container-registry-unavailable":"Cloudflare could not verify Container image access. No Tiller resources were created, so it is safe to try again. ",
    "installation-restart-required":"The Worker recorded by this installation no longer exists, so the saved operation cannot continue. If you already removed its partial Tiller resources, no more cleanup is needed. ",
    "manual-cleanup-required":"The deployment stopped after Cloudflare resources may have been created. Review and remove the partial Tiller resources before trying again. ",
    "reauthorization-required":"Cloudflare authorization expired. Authorize again to continue the same operation. ",
    "access-repair-required":"Tiller could not prove the installed Access credentials. Repair Access before continuing. ",
    "topology-drift":"The installed Tiller topology differs from the fixed v1 topology. No update was applied. "
  };
  function setText(element,value){if(element.textContent!==value)element.textContent=value}
  function applyIntent(value){if(value!=="install"&&value!=="update"&&value!=="renew")return;currentIntent=value;const copy=progressCopy[currentIntent];if(document.title!==copy.heading)document.title=copy.heading;setText(heading,copy.heading);setText(context,copy.context);setText(middleStage.querySelector(".stage-label"),copy.middleStage);setText(reassurance,reassuranceMessage())}
  function restartUrl(){return currentIntent==="install"?"/deploy":"/maintenance?intent="+encodeURIComponent(currentIntent)}
  function reassuranceMessage(){return "You can close this tab. The "+progressCopy[currentIntent].operation+" will continue in Cloudflare."}
  function attentionMessage(){return "Cloudflare needs your attention before the "+progressCopy[currentIntent].operation+" can continue. "}
  function actionMessage(status){const detail=typeof status.detail==="string"&&status.detail.length<=2048?status.detail.trim():"";return detail?detail+" ":issues[status.issue]||attentionMessage()}
  function reconnectMessage(){return "Waiting to reconnect to the "+progressCopy[currentIntent].operation+"…"}
  function showReassurance(value){reassurance.hidden=!value}
  function render(stage){const complete=stage==="completed";const active=complete?order.length-1:order.indexOf(stage);if(active<0)return;order.forEach((name,index)=>{const item=document.getElementById(name);const state=complete||index<active?"done":index===active?"active":"pending";item.dataset.state=state;if(state==="active")item.setAttribute("aria-current","step");else item.removeAttribute("aria-current")});const target=document.getElementById(order[active]);if(message.parentElement!==target)target.append(message)}
  function setProgressMessage(detail){const value=typeof detail==="string"?detail.trim():"";setText(message,value)}
  async function poll(){
    try{
      const response=await fetch("/jobs/"+encodeURIComponent(jobId)+"/status",{cache:"no-store",credentials:"same-origin"});
      if(response.status===404){showReassurance(false);message.replaceChildren(document.createTextNode("This browser authorization expired. Authorize Cloudflare again to resume the account operation. "));const link=document.createElement("a");link.href=restartUrl();link.textContent="Authorize Cloudflare";message.append(link);return}
      if(!response.ok)throw new Error();const status=await response.json();
      if(status&&typeof status==="object")applyIntent(status.intent);
      if(order.includes(status.stage)){render(status.stage);showReassurance(true);setProgressMessage(status.detail)}
      else if(status.stage==="completed"){
        render("completed");showReassurance(false);message.replaceChildren();const link=document.createElement("a");link.href=status.hubUrl;link.textContent="Open your Hub";message.append(link);try{location.replace(status.hubUrl)}catch{}return
      }else if(status.stage==="action-required"){
        showReassurance(false);message.replaceChildren(document.createTextNode(actionMessage(status)));
        if(status.nextAction&&typeof status.nextAction.url==="string"){
          const link=document.createElement("a");link.href=status.nextAction.url;link.textContent=status.nextAction.kind==="start-fresh"?"Start fresh installation":"Authorize Cloudflare";message.append(link)
        }else if(status.issue==="access-destination-conflict"){
          const link=document.createElement("a");link.href="https://one.dash.cloudflare.com";link.textContent="Open Cloudflare Access";message.append(link)
        }else if(status.issue==="container-registry-repair-required"){
          const link=document.createElement("a");link.href="/deploy";link.textContent="Start again after repair";message.append(link)
        }else if(status.issue==="container-registry-unavailable"){
          const link=document.createElement("a");link.href="/deploy";link.textContent="Try installation again";message.append(link)
        }else if(status.issue==="manual-cleanup-required"){
          const link=document.createElement("a");link.href="/deploy";link.textContent="Start again after cleanup";message.append(link)
        }return
      }else if(status.stage==="failed"){showReassurance(false);setText(message,status.error.message);return}
    }catch{showReassurance(true);setText(message,reconnectMessage())}
    setTimeout(poll,1500)
  }
  render("connect-cloudflare");poll();
</script></body></html>`;
}

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  const hostname = new URL(c.req.url).hostname.toLowerCase();
  if (hostname.endsWith(".workers.dev") && c.req.path !== "/stable") {
    noStore(c);
    return c.json({ error: "not_found" }, 404);
  }
  await next();
});

app.get("/deploy", (c) => startDeployment(c));
app.post("/deploy", (c) => submitDeployment(c));
app.get("/maintenance", (c) => startMaintenance(c));

app.get("/stable", (c) => stableRelease(c));

app.get("/oauth/callback", async (c) => {
  noStore(c);
  const state = c.req.query("state")?.trim() ?? "";
  const jobId = callbackJobId(state);
  const session = cookieValue(c.req.raw, SESSION_COOKIE);
  if (!jobId || !session) return c.text("This Cloudflare callback is not valid.", 400);
  const response = await internalFetch(c.env, jobId, "/callback", session, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state,
      ...(c.req.query("code") ? { code: c.req.query("code") } : {}),
      ...(c.req.query("error") ? { error: c.req.query("error") } : {}),
    }),
  });
  if (!response.ok) return c.text("This Cloudflare callback has expired or was already used.", 409);
  const result = await response.json<{ intent?: unknown }>()
    .catch((): { intent?: unknown } => ({}));
  const intent = lifecycleIntentParam(result.intent);
  if (!intent) return c.text("This Cloudflare callback is invalid.", 502);
  return c.redirect(`${publicOrigin(c.env)}/jobs/${encodeURIComponent(jobId)}?intent=${intent}`, 303);
});

app.get("/jobs/:jobId", (c) => {
  noStore(c);
  const jobId = validJobId(c.req.param("jobId"));
  const params = new URL(c.req.url).searchParams;
  const intent = lifecycleIntentParam(params.get("intent"));
  if (!jobId || params.size !== 1 || !intent || !cookieValue(c.req.raw, SESSION_COOKIE)) {
    return c.text("Deployment job not found.", 404);
  }
  const nonce = randomBase64Url(18);
  c.header("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  return c.html(progressHtml(jobId, nonce, intent));
});

app.get("/jobs/:jobId/status", async (c) => {
  noStore(c);
  const jobId = validJobId(c.req.param("jobId"));
  const session = cookieValue(c.req.raw, SESSION_COOKIE);
  if (!jobId || !session) return c.json({ error: "not_found" }, 404);
  const response = await internalFetch(c.env, jobId, "/status", session);
  const headers = new Headers(c.res.headers);
  const contentType = response.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  return new Response(response.body, { status: response.status, headers });
});

app.get("/", (c) => {
  noStore(c);
  return c.text("Tiller installer", 404);
});

app.notFound((c) => {
  noStore(c);
  return c.json({ error: "not_found" }, 404);
});

app.onError((_error, c) => {
  noStore(c);
  return c.json({ error: "request_failed" }, 500);
});

export { AccountLifecycleDO, InstallJobDO };
export default app;
