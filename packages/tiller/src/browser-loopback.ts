import { spawn } from "node:child_process";
import { randomUUID, webcrypto } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { exportJWK } from "jose";

const LISTENER_FORCE_CLOSE_MS = 250;

export interface BrowserLoopbackContext {
  hubUrl: string;
  state: string;
  privateKey: CryptoKey;
}

interface BrowserLoopbackMessages {
  bodyTooLarge: string;
  bodyEmpty: string;
  bodyInvalid: string;
  alreadyConsumed: string;
  callbackFailed: string;
  listenFailed: string;
  timeout: string;
  cancelled: string;
  opening: (hubUrl: string) => string;
  browserFallback: string;
  manualPrompt: string;
  manualRetry: (error: string) => string;
}

export interface BrowserLoopbackOptions<Result> {
  hubUrl: string;
  callbackPath: string;
  callbackTimeoutMs: number;
  maxBodyBytes: number;
  messages: BrowserLoopbackMessages;
  buildBrowserUrl: (input: {
    hubUrl: string;
    port: number;
    state: string;
    encodedPublicKey: string;
  }) => string;
  decodeCallbackBody: (
    value: unknown,
    context: BrowserLoopbackContext,
  ) => Result | Promise<Result>;
  decodeManualCode: (
    code: string,
    context: BrowserLoopbackContext,
  ) => Result | Promise<Result>;
}

export interface BrowserLoopbackDependencies {
  openBrowser?: (url: string) => Promise<boolean>;
  writeStderr?: (message: string) => void;
  interactive?: boolean;
  signalSource?: Pick<NodeJS.Process, "once" | "off">;
}

interface ManualPrompt {
  done: Promise<void>;
  stop: () => void;
}

export function exactBrowserHubOrigin(value: string): string {
  const parsed = new URL(value.trim());
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.username
    || parsed.password
    || (parsed.pathname !== "/" && parsed.pathname !== "")
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("Hub URL must be an exact HTTP or HTTPS origin.");
  }
  return parsed.origin;
}

export function normalizeBrowserConnectionCode(value: string): string {
  return value.trim().replace(/\s+/g, "");
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "300",
    Vary: "Origin",
  };
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  allowedOrigin?: string,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(allowedOrigin ? corsHeaders(allowedOrigin) : {}),
  });
  res.end(`${JSON.stringify(body)}\n`);
}

async function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes: number,
  messages: Pick<BrowserLoopbackMessages, "bodyTooLarge" | "bodyEmpty" | "bodyInvalid">,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += next.length;
    if (total > maxBodyBytes) throw new Error(messages.bodyTooLarge);
    chunks.push(next);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new Error(messages.bodyEmpty);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(messages.bodyInvalid);
  }
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    server.closeAllConnections();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const forceClose = setTimeout(() => server.closeAllConnections(), LISTENER_FORCE_CLOSE_MS);
    server.close((error) => {
      clearTimeout(forceClose);
      if (error) reject(error);
      else resolve();
    });
  });
}

export function browserLaunchCommand(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } {
  return platform === "darwin"
    ? { cmd: "open", args: [url] }
    : platform === "win32"
      ? { cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
      : { cmd: "xdg-open", args: [url] };
}

function openBrowser(url: string): Promise<boolean> {
  const command = browserLaunchCommand(process.platform, url);
  return new Promise((resolve) => {
    const child = spawn(command.cmd, command.args, { stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => child.unref());
    child.once("close", (code) => resolve(code === 0));
  });
}

function startManualPrompt<Result>(
  options: BrowserLoopbackOptions<Result>,
  context: BrowserLoopbackContext,
  complete: (result: Result) => Promise<void>,
  writeStderr: (message: string) => void,
  interactive: boolean,
): ManualPrompt | null {
  if (!interactive) return null;
  const rl = createInterface({ input, output });
  const controller = new AbortController();
  let stopped = false;
  writeStderr(options.messages.manualPrompt);
  const done = (async () => {
    while (!stopped) {
      let code = "";
      try {
        code = await rl.question("Connection code: ", { signal: controller.signal });
      } catch (error) {
        if (stopped || (error instanceof Error && error.name === "AbortError")) return;
        throw error;
      }
      if (stopped || !code.trim()) continue;
      try {
        await complete(await options.decodeManualCode(code, context));
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeStderr(options.messages.manualRetry(message));
      }
    }
  })().finally(() => rl.close());
  return {
    done,
    stop: () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      rl.close();
    },
  };
}

export async function runBrowserLoopback<Result>(
  options: BrowserLoopbackOptions<Result>,
  dependencies: BrowserLoopbackDependencies = {},
): Promise<Result> {
  const hubUrl = exactBrowserHubOrigin(options.hubUrl);
  const expectedOrigin = new URL(hubUrl).origin;
  const state = randomUUID();
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey", "deriveBits"],
  ) as CryptoKeyPair;
  let privateKey: CryptoKey | null = keyPair.privateKey;
  const publicKeyJwk = await exportJWK(keyPair.publicKey);
  const encodedPublicKey = Buffer.from(JSON.stringify(publicKeyJwk), "utf8").toString("base64url");
  const writeStderr = dependencies.writeStderr ?? ((message: string) => process.stderr.write(message));
  const launchBrowser = dependencies.openBrowser ?? openBrowser;
  const interactive = dependencies.interactive ?? Boolean(input.isTTY && output.isTTY);
  const signalSource = dependencies.signalSource ?? process;
  let settled = false;
  let resolveResult!: (result: Result) => void;
  let rejectResult!: (reason?: unknown) => void;
  const resultPromise = new Promise<Result>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const server = createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
      const origin = readHeader(req.headers.origin);
      const validOrigin = origin === expectedOrigin;
      if (requestUrl.pathname !== options.callbackPath || requestUrl.search || requestUrl.hash) {
        writeJson(res, 404, { error: "Not found." });
        return;
      }
      if (req.method === "OPTIONS") {
        const requestedMethod = readHeader(req.headers["access-control-request-method"]);
        if (!validOrigin || requestedMethod !== "POST") {
          writeJson(res, 403, { error: "Origin not allowed." });
          return;
        }
        res.writeHead(204, corsHeaders(expectedOrigin));
        res.end();
        return;
      }
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "Method not allowed." });
        return;
      }
      if (!validOrigin) {
        writeJson(res, 403, { error: "Origin not allowed." });
        return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
        writeJson(res, 415, { error: "Content-Type must be application/json." }, expectedOrigin);
        return;
      }
      if (settled) {
        writeJson(res, 409, { error: options.messages.alreadyConsumed }, expectedOrigin);
        return;
      }
      try {
        const value = await readJsonBody(req, options.maxBodyBytes, options.messages);
        if (!privateKey) throw new Error("The connection key is no longer available.");
        const result = await options.decodeCallbackBody(value, { hubUrl, state, privateKey });
        const responseFinished = new Promise<void>((resolve) => res.once("finish", resolve));
        writeJson(res, 200, { ok: true }, expectedOrigin);
        await responseFinished;
        await complete(result);
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : options.messages.callbackFailed,
        }, expectedOrigin);
      }
    })().catch(() => {
      if (!res.headersSent) writeJson(res, 500, { error: options.messages.callbackFailed });
      else res.destroy();
    });
  });

  const complete = async (result: Result): Promise<void> => {
    if (settled) return;
    settled = true;
    await closeServer(server).catch(() => undefined);
    resolveResult(result);
  };

  let manualPrompt: ManualPrompt | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (settled) return;
    settled = true;
    manualPrompt?.stop();
    rejectResult(new Error(options.messages.cancelled));
    void closeServer(server).catch(() => undefined);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address() as AddressInfo | null;
    if (!address?.port) throw new Error(options.messages.listenFailed);
    signalSource.once("SIGINT", cancel);
    signalSource.once("SIGTERM", cancel);
    const browserUrl = options.buildBrowserUrl({
      hubUrl,
      port: address.port,
      state,
      encodedPublicKey,
    });
    writeStderr(options.messages.opening(hubUrl));
    if (!privateKey) throw new Error("The connection key is no longer available.");
    const context = { hubUrl, state, privateKey };
    manualPrompt = startManualPrompt(options, context, complete, writeStderr, interactive);
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectResult(new Error(options.messages.timeout));
      void closeServer(server).catch(() => undefined);
    }, options.callbackTimeoutMs);
    void launchBrowser(browserUrl).then((opened) => {
      if (opened || settled) return;
      writeStderr(options.messages.browserFallback);
      writeStderr(`${browserUrl}\n`);
    }, () => {
      if (settled) return;
      writeStderr(options.messages.browserFallback);
      writeStderr(`${browserUrl}\n`);
    });
    return await resultPromise;
  } finally {
    signalSource.off("SIGINT", cancel);
    signalSource.off("SIGTERM", cancel);
    if (timeout) clearTimeout(timeout);
    manualPrompt?.stop();
    await manualPrompt?.done.catch(() => undefined);
    await closeServer(server).catch(() => undefined);
    privateKey = null;
  }
}
