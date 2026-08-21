import { spawnSync } from "node:child_process";
import { resolve4 } from "node:dns/promises";

export interface HealthResult {
  ok: boolean;
  detail?: string;
}

function isIpv4Address(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
}

async function resolveHostname(hostname: string): Promise<boolean> {
  try {
    await resolve4(hostname);
    return true;
  } catch {
    return false;
  }
}

async function resolveViaCloudflareDns(hostname: string): Promise<string[]> {
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(2500),
      },
    );
    if (!response.ok) return [];

    const body = await response.json() as {
      Status?: number;
      Answer?: Array<{ type?: number; data?: string }>;
    };

    if (body.Status !== 0 || !Array.isArray(body.Answer)) return [];

    return body.Answer
      .filter((answer) => answer?.type === 1 && typeof answer.data === "string" && answer.data.trim())
      .map((answer) => answer.data!.trim());
  } catch {
    return [];
  }
}

function curlHealthCheck(url: string, ip: string, headers?: HeadersInit): HealthResult {
  const target = new URL(url);
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  const curlArgs = [
    "--silent",
    "--show-error",
    "--output",
    "/dev/null",
    "--write-out",
    "%{http_code}",
    "--resolve",
    `${target.hostname}:${port}:${ip}`,
  ];
  const headerInput = headers
    ? Array.from(new Headers(headers).entries(), ([name, value]) => `${name}: ${value}\n`).join("")
    : "";
  if (headerInput) curlArgs.push("--header", "@-");

  curlArgs.push(url);

  const childEnv = { ...process.env };
  delete childEnv.CF_ACCESS_CLIENT_ID;
  delete childEnv.CF_ACCESS_CLIENT_SECRET;

  const result = spawnSync("curl", curlArgs, {
    encoding: "utf8",
    env: childEnv,
    input: headerInput,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5000,
  });

  if (result.status !== 0) {
    return {
      ok: false,
      detail: result.stderr.trim() || result.stdout.trim() || `curl exited with ${result.status ?? "unknown"}`,
    };
  }

  const statusCode = Number.parseInt(result.stdout.trim(), 10);
  if (statusCode >= 200 && statusCode < 300) {
    return { ok: true, detail: url };
  }

  return {
    ok: false,
    detail: `${url} -> ${Number.isFinite(statusCode) ? statusCode : result.stdout.trim() || "unknown"}`,
  };
}

export async function checkHttpHealth(url: string, headers?: HeadersInit): Promise<HealthResult> {
  try {
    const hostname = new URL(url).hostname;
    if (hostname && !isIpv4Address(hostname)) {
      const resolved = await resolveHostname(hostname);
      if (!resolved) {
        const fallbackIps = await resolveViaCloudflareDns(hostname);
        let lastFailure: HealthResult | undefined;
        for (const ip of fallbackIps) {
          const result = curlHealthCheck(url, ip, headers);
          if (result.ok) return result;
          lastFailure = result;
        }
        if (lastFailure) return lastFailure;
        return { ok: false, detail: `DNS not yet available for ${hostname}` };
      }
    }

    const response = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(2500),
    });

    return response.ok
      ? { ok: true, detail: url }
      : { ok: false, detail: `${url} -> ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
