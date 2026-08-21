#!/usr/bin/env node

const action = process.argv[2] || "";
const DEFAULT_BRIDGE_RETRY_SECONDS = 30;
const DEFAULT_BRIDGE_RETRY_INTERVAL_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
  });
}

function parseCredentialInput(input) {
  const result = {};
  for (const line of input.split(/\r?\n/)) {
    if (!line) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

function stripGitSuffix(value) {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function canonicalOwnerRepo(owner, repo) {
  const cleanOwner = decodeURIComponent(owner || "").trim().toLowerCase();
  const cleanRepo = stripGitSuffix(decodeURIComponent(repo || "").trim()).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(cleanOwner)) return null;
  if (!/^[a-z0-9._-]+$/.test(cleanRepo)) return null;
  return `${cleanOwner}/${cleanRepo}`;
}

function repoFromPath(path) {
  const parts = String(path || "").replace(/^\/+/, "").replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return canonicalOwnerRepo(parts[0], parts[1]);
}

function retrySeconds() {
  const raw = Number.parseInt(process.env.TILLER_GITHUB_BRIDGE_TOKEN_RETRY_SECONDS || "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BRIDGE_RETRY_SECONDS;
}

function retryIntervalMs() {
  const raw = Number.parseInt(process.env.TILLER_GITHUB_BRIDGE_TOKEN_RETRY_INTERVAL_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BRIDGE_RETRY_INTERVAL_MS;
}

function isBridgeNotFound(response, body) {
  return response.status === 401 && body && typeof body === "object" && body.code === "github_bridge_not_found";
}

async function requestToken(hubUrl, requestedRepo, headers) {
  const response = await fetch(`${hubUrl}/api/github/token?repo=${encodeURIComponent(requestedRepo)}`, {
    headers,
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  return { response, text, body };
}

async function main() {
  const input = parseCredentialInput(await readStdin());
  if (action !== "get") {
    return;
  }
  if (input.host !== "github.com") {
    return;
  }

  const requestedRepo = repoFromPath(input.path);
  if (!requestedRepo) {
    console.error("[git-credential-tiller] Git did not provide a repository path. Set credential.https://github.com.useHttpPath=true.");
    process.exit(1);
  }

  const allowedRepo = canonicalOwnerRepo(
    ...(process.env.TILLER_GITHUB_ALLOWED_REPO || "").split("/", 2),
  );
  if (!allowedRepo || requestedRepo !== allowedRepo) {
    console.error(`[git-credential-tiller] Bridge is not allowed to access ${requestedRepo}.`);
    process.exit(1);
  }

  const hubUrl = (process.env.HUB_URL || "").replace(/\/+$/, "");
  const bridgeId = process.env.TILLER_GITHUB_BRIDGE_ID || "";
  const bridgeSecret = process.env.TILLER_GITHUB_BRIDGE_SECRET || "";
  if (!hubUrl || !bridgeId || !bridgeSecret) {
    console.error("[git-credential-tiller] GitHub bridge environment is not configured.");
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${bridgeSecret}`,
    "X-Tiller-GitHub-Bridge-Id": bridgeId,
  };
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
  }

  const retryUntilMs = Date.now() + retrySeconds() * 1000;
  const retryDelayMs = retryIntervalMs();
  let result = await requestToken(hubUrl, requestedRepo, headers);
  while (!result.response.ok && isBridgeNotFound(result.response, result.body) && Date.now() < retryUntilMs) {
    await sleep(Math.min(retryDelayMs, Math.max(0, retryUntilMs - Date.now())));
    result = await requestToken(hubUrl, requestedRepo, headers);
  }

  if (!result.response.ok || typeof result.body.token !== "string" || !result.body.token) {
    const message = typeof result.body.error === "string" ? result.body.error : result.text || `HTTP ${result.response.status}`;
    const code = typeof result.body.code === "string" ? ` (${result.body.code})` : "";
    console.error(`[git-credential-tiller] ${message}${code}`);
    process.exit(1);
  }

  process.stdout.write("username=x-access-token\n");
  process.stdout.write(`password=${result.body.token}\n\n`);
}

main().catch((error) => {
  console.error(`[git-credential-tiller] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
