import { chmodSync, chownSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveOpenCodeSelection,
  type OpenCodeConfigEnv,
} from "../opencode-config.js";
import type { TerminalPalette } from "../vt-palette-query-filter.js";
import type { NativeTuiLaunch, PlanWriterContext } from "./contract.js";
import {
  OPENCODE_REPO_PLAN_TOOLS,
  REPO_PLANS_MCP_COMMAND,
  REPO_PLANS_SERVER_NAME,
  repoPlansEnabled,
} from "./repo-plans.js";

export const OPENCODE_READY_DEADLINE_MS = 45_000;
export const OPENCODE_DENIED_READ_RELATIVE_PATH =
  ".git/tiller-opencode-read-denied";

// OpenCode mini starts before its browser terminal is mounted, so answer its
// palette probes inside the managed PTY. This intentionally uses the neutral
// light terminal palette shared by both Tiller themes; it must not freeze the
// footer to either Paperwing or Classic when the browser theme changes.
export const OPENCODE_PLAN_WRITER_TERMINAL_PALETTE: TerminalPalette = {
  background: "#ffffff",
  foreground: "#24292f",
  cursor: "#0969da",
  selectionBackground: "#dbeafe",
  selectionForeground: "#24292f",
  ansi: [
    "#24292f",
    "#cf222e",
    "#1a7f37",
    "#9a6700",
    "#0969da",
    "#8250df",
    "#0969da",
    "#6e7781",
    "#57606a",
    "#a40e26",
    "#116329",
    "#7d4e00",
    "#218bff",
    "#a475f9",
    "#3192aa",
    "#24292f",
  ],
};

export async function waitForOpenCodeReady(
  readiness: readonly Promise<unknown>[],
  deadlineMs = OPENCODE_READY_DEADLINE_MS,
): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.all(readiness).then(() => undefined),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new Error(
                `OpenCode did not complete its managed ready handshake within ${deadlineMs}ms.`,
              ),
            ),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

const BASE_ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "TZ",
] as const;

function copyAllowed(
  source: NodeJS.ProcessEnv,
  target: Record<string, string>,
): void {
  for (const key of BASE_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
}

function writableDirectory(
  path: string,
  account: { uid: number; gid: number },
): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  chownSync(path, account.uid, account.gid);
}

function protectedDirectory(
  path: string,
  owner: { uid: number; gid: number },
): void {
  mkdirSync(path, { recursive: true, mode: 0o555 });
  chownSync(path, owner.uid, owner.gid);
  chmodSync(path, 0o555);
}

export function buildOpenCodePlanWriterConfig(input: {
  context: PlanWriterContext;
  pluginPath: string;
  toolOutputGlob: string;
  source?: OpenCodeConfigEnv;
}) {
  const selection = resolveOpenCodeSelection(input.source ?? process.env);
  if (!selection) throw new Error("OpenCode writer selection is required.");
  if (input.context.writer.provider !== "opencode") {
    throw new Error("OpenCode launch requires an OpenCode writer context.");
  }
  if (input.context.writer.model !== selection.modelId) {
    throw new Error(
      "OpenCode writer context model does not match the frozen runtime selection.",
    );
  }
  const selectedModel = `${selection.providerAlias}/${selection.modelAlias}`;
  const effort = input.context.writer.effort?.trim();
  if (!effort) throw new Error("OpenCode writer reasoning effort is required.");
  const modelOptions =
    selection.providerKind === "anthropic"
      ? { thinking: { type: "adaptive", display: "summarized" }, effort }
      : { reasoningEffort: effort };
  const externalDirectory = {
    "*": "deny",
    [input.toolOutputGlob]: "deny",
  };
  const repoPlans = repoPlansEnabled(input.context);

  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    shell: "/bin/false",
    enabled_providers: [selection.providerAlias],
    provider: {
      [selection.providerAlias]: {
        npm: selection.providerPackage,
        name: selection.providerLabel,
        options: {
          baseURL: selection.baseURL,
          apiKey: selection.apiKey,
          ...(selection.providerKind === "cloudflare-workers-ai" &&
          input.source?.CF_ACCESS_CLIENT_ID &&
          input.source?.CF_ACCESS_CLIENT_SECRET
            ? {
                headers: {
                  "CF-Access-Client-Id": input.source.CF_ACCESS_CLIENT_ID,
                  "CF-Access-Client-Secret":
                    input.source.CF_ACCESS_CLIENT_SECRET,
                },
              }
            : {}),
        },
        models: {
          [selection.modelAlias]: {
            id: selection.modelId,
            name: selection.modelLabel,
            reasoning: true,
            limit: selection.modelLimit,
            options: modelOptions,
            variants: {
              [effort]: modelOptions,
            },
          },
        },
      },
    },
    model: selectedModel,
    small_model: selectedModel,
    default_agent: "plan",
    agent: {
      build: { disable: true },
      general: { disable: true },
      explore: { disable: true },
      plan: {
        model: selectedModel,
        variant: effort,
        permission: {
          "*": "deny",
          read: "allow",
          glob: "allow",
          grep: "allow",
          question: "allow",
          webfetch: "allow",
          websearch: "allow",
          publish_plan: "allow",
          ...(repoPlans
            ? Object.fromEntries(
                OPENCODE_REPO_PLAN_TOOLS.map((tool) => [tool, "allow"]),
              )
            : {}),
          external_directory: externalDirectory,
        },
      },
    },
    mcp: repoPlans
      ? {
          [REPO_PLANS_SERVER_NAME]: {
            type: "local",
            command: [REPO_PLANS_MCP_COMMAND],
            enabled: true,
          },
        }
      : {},
    plugin: [pathToFileURL(input.pluginPath).href],
  };
}

/** Escape OpenCode's pre-JSON {env:...}/{file:...} interpolation syntax. */
export function renderOpenCodePlanWriterConfig(
  config: ReturnType<typeof buildOpenCodePlanWriterConfig>,
): string {
  return `${JSON.stringify(config, null, 2).replace(/\{(?=(?:env|file):[^}]+\})/g, "\\u007b")}\n`;
}

export function renderOpenCodePlanWriterPlugin(input: {
  socketPath: string;
  contextPath: string;
  checkoutDir: string;
  providerId: string;
  modelId: string;
  variant: string;
}): string {
  const contract = JSON.stringify({
    ...input,
    agent: "plan",
    deniedReadPath: join(input.checkoutDir, OPENCODE_DENIED_READ_RELATIVE_PATH),
  });
  return `import { lstat, readFile, realpath } from "node:fs/promises";
import http from "node:http";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const contract = ${contract};
let boundSessionId = null;
let turnActive = false;
let eventTail = Promise.resolve();
let checkoutRoot = null;
let deniedReadPath = null;
const deniedReadRequests = new Set();

function post(message, timeoutMs = 15000) {
  const body = JSON.stringify(message);
  const signal = timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: contract.socketPath,
      path: "/opencode-hook",
      method: "POST",
      ...(signal ? { signal } : {}),
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        const parsed = (() => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } })();
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(parsed.error || \`Tiller OpenCode hook returned HTTP \${response.statusCode}\`));
          return;
        }
        resolve(parsed);
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

function normalizeModel(model) {
  const providerId = typeof model?.providerID === "string" ? model.providerID.trim() : "";
  const rawModelId = model?.modelID ?? model?.id;
  const modelId = typeof rawModelId === "string" ? rawModelId.trim() : "";
  const variant = typeof model?.variant === "string" ? model.variant.trim() : "";
  return { providerId, modelId, variant };
}

function isInsideCheckout(path) {
  const remainder = relative(checkoutRoot, path);
  return remainder === "" || (
    remainder !== ".." &&
    !remainder.startsWith(".." + sep) &&
    !isAbsolute(remainder)
  );
}

async function requireCheckoutPath(path, label) {
  if (typeof path !== "string" || !path.trim()) {
    throw new Error(\`OpenCode produced invalid \${label} path metadata.\`);
  }
  let canonical;
  try {
    canonical = await realpath(isAbsolute(path) ? path : resolve(checkoutRoot, path));
  } catch {
    throw new Error(\`OpenCode could not validate the \${label} path.\`);
  }
  if (!isInsideCheckout(canonical)) {
    throw new Error("File references outside the managed checkout are unavailable.");
  }
  return canonical;
}

async function safeReadPath(path) {
  if (typeof path !== "string" || !path.trim()) {
    return deniedReadPath;
  }
  const candidate = isAbsolute(path) ? path : resolve(checkoutRoot, path);
  let canonical;
  try {
    canonical = await realpath(candidate);
  } catch {
    const suffix = [];
    let ancestor = candidate;
    while (true) {
      try {
        canonical = resolve(await realpath(ancestor), ...suffix.reverse());
        break;
      } catch (error) {
        try {
          const entry = await lstat(ancestor);
          if (entry.isSymbolicLink()) canonical = undefined;
          break;
        } catch (entryError) {
          if (entryError?.code !== "ENOENT") {
            canonical = undefined;
            break;
          }
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) {
          canonical = undefined;
          break;
        }
        suffix.push(basename(ancestor));
        ancestor = parent;
      }
    }
    if (canonical && isInsideCheckout(canonical)) return canonical;
    deniedReadRequests.add(candidate);
    return deniedReadPath;
  }
  if (isInsideCheckout(canonical)) return canonical;
  deniedReadRequests.add(candidate);
  deniedReadRequests.add(canonical);
  return deniedReadPath;
}

async function requireCheckoutAttachments(parts) {
  if (!Array.isArray(parts)) {
    throw new Error("OpenCode resolved a chat message without attachment parts.");
  }
  const paths = new Set();
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "file") {
      if (typeof part.url !== "string" || !part.url) {
        throw new Error("OpenCode produced an invalid file attachment URL.");
      }
      let url;
      try {
        url = new URL(part.url);
      } catch {
        throw new Error("OpenCode produced an invalid file attachment URL.");
      }
      if (url.protocol === "file:") paths.add(fileURLToPath(url));
      else if (url.protocol !== "data:") {
        throw new Error("OpenCode produced an unsupported file attachment URL.");
      }
      if (part.source?.type === "file" || part.source?.type === "symbol") {
        paths.add(part.source.path);
      }
    }

    const marker = "Called the Read tool with the following input: ";
    if (part.type === "text" && part.synthetic === true && typeof part.text === "string" && part.text.startsWith(marker)) {
      let args;
      try {
        args = JSON.parse(part.text.slice(marker.length));
      } catch {
        throw new Error("OpenCode produced invalid resolved file metadata.");
      }
      if (typeof args?.filePath !== "string" || !args.filePath) {
        throw new Error("OpenCode produced invalid resolved file metadata.");
      }
      const candidate = isAbsolute(args.filePath)
        ? args.filePath
        : resolve(checkoutRoot, args.filePath);
      // OpenCode records the originally requested path in the synthetic tool
      // transcript even when tool.execute.before redirected a denied read to
      // the protected marker. That transcript contains no external contents.
      if (deniedReadRequests.has(candidate)) continue;
      paths.add(args.filePath);
    }
  }

  for (const path of paths) await requireCheckoutPath(path, "resolved attachment");
}

function enqueueEvent(operation) {
  const current = eventTail.then(operation);
  eventTail = current.catch(() => {});
  return current;
}

async function bind(output) {
  const message = output?.message;
  const sessionId = typeof message?.sessionID === "string" ? message.sessionID.trim() : "";
  const agent = typeof message?.agent === "string" ? message.agent.trim() : "";
  const model = normalizeModel(message?.model);
  await post({
    type: "bind",
    sessionId,
    agent,
    providerId: model.providerId,
    modelId: model.modelId,
    variant: model.variant,
  });
  boundSessionId = sessionId;
}

async function reportIdentityDrift(identity) {
  await post({
    type: "bind",
    sessionId: identity.sessionId,
    agent: identity.agent,
    providerId: identity.providerId,
    modelId: identity.modelId,
    variant: identity.variant,
  });
  throw new Error("OpenCode writer generation invariant failed.");
}

export default async function tillerOpenCodeWriter() {
  checkoutRoot = await realpath(contract.checkoutDir);
  deniedReadPath = await requireCheckoutPath(
    contract.deniedReadPath,
    "external-read denial marker",
  );
  await post({ type: "ready" });
  return {
    "chat.message": (_input, output) => enqueueEvent(async () => {
      await bind(output);
      await requireCheckoutAttachments(output?.parts);
    }),
    "tool.execute.before": (input, output) => enqueueEvent(async () => {
      if (input?.tool !== "read") return;
      const sessionId = typeof input?.sessionID === "string" ? input.sessionID.trim() : "";
      if (!boundSessionId || sessionId !== boundSessionId) {
        await reportIdentityDrift({ sessionId });
      }
      output.args.filePath = await safeReadPath(output?.args?.filePath);
    }),
    "experimental.chat.system.transform": (input, output) => enqueueEvent(async () => {
      const sessionId = typeof input?.sessionID === "string" ? input.sessionID.trim() : "";
      const model = normalizeModel(input?.model);
      if (
        !boundSessionId ||
        sessionId !== boundSessionId ||
        model.providerId !== contract.providerId ||
        model.modelId !== contract.modelId
      ) {
        await reportIdentityDrift({
          sessionId,
          providerId: model.providerId,
          modelId: model.modelId,
        });
      }
      output.system.push(await readFile(contract.contextPath, "utf8"));
    }),
    event: ({ event }) => enqueueEvent(async () => {
      if (event?.type !== "session.status" && event?.type !== "session.idle") return;
      const properties = event.properties ?? {};
      const sessionId = typeof properties.sessionID === "string" ? properties.sessionID.trim() : "";
      if (!boundSessionId) return;
      if (sessionId !== boundSessionId) {
        await reportIdentityDrift({ sessionId });
      }
      const state = event.type === "session.idle" ? "idle" : properties.status?.type;
      if (state === "busy" || state === "retry") {
        await post({ type: "activity", state, sessionId });
        turnActive = true;
        return;
      }
      if (state === "idle" && turnActive) {
        await post({ type: "activity", state, sessionId });
        turnActive = false;
      }
    }),
    tool: {
      publish_plan: {
        description: "Publish the complete current plan to Tiller without leaving Plan mode.",
        args: {
          markdown: { type: "string", description: "The complete plan in Markdown." },
        },
        async execute(args, context) {
          if (!args || typeof args.markdown !== "string" || !args.markdown.trim()) {
            throw new Error("publish_plan requires non-empty Markdown.");
          }
          await eventTail;
          // OpenCode 1.18.18 forwards callID internally even though its public
          // custom-tool context type omits that field, so guard the runtime view.
          const runtime = context;
          const callID = typeof runtime.callID === "string" ? runtime.callID : "";
          if (!callID) throw new Error("OpenCode did not provide publish_plan runtime callID.");
          if (!boundSessionId) {
            await post({ type: "publish", sessionId: context.sessionID, callID, markdown: args.markdown }, null);
            throw new Error("OpenCode writer generation invariant failed.");
          }
          if (context.sessionID !== boundSessionId || context.agent !== contract.agent) {
            await reportIdentityDrift({ sessionId: context.sessionID, agent: context.agent });
          }
          await post({
            type: "publish",
            sessionId: boundSessionId,
            callID,
            markdown: args.markdown,
          }, null);
          return "Plan published to Tiller. Remain in Plan mode and continue helping the user.";
        },
      },
    },
  };
}
`;
}

export async function buildOpenCodeLaunch(input: {
  context: PlanWriterContext;
  checkoutDir: string;
  home: string;
  socketPath: string;
  contextPath: string;
  terminalId: string;
  account: { uid: number; gid: number };
  /** Test seam; production always leaves this unset and therefore root-owned. */
  protectedOwner?: { uid: number; gid: number };
  source?: NodeJS.ProcessEnv;
}): Promise<
  NativeTuiLaunch & { providerId: string; modelId: string; variant: string }
> {
  const source = input.source ?? process.env;
  const selection = resolveOpenCodeSelection(source);
  if (!selection) throw new Error("OpenCode writer selection is required.");
  const root = join(dirname(input.home), "opencode-runtime");
  const home = join(root, "home");
  const configHome = join(root, "xdg-config");
  const openCodeConfigDir = join(configHome, "opencode");
  const dataHome = join(root, "xdg-data");
  const cacheHome = join(root, "xdg-cache");
  const stateHome = join(root, "xdg-state");
  const tempHome = join(root, "tmp");
  const managed = join(root, "managed");
  const configPath = join(managed, "opencode.json");
  const pluginPath = join(managed, "tiller-writer-plugin.mjs");
  const protectedOwner = input.protectedOwner ?? { uid: 0, gid: 0 };
  const config = buildOpenCodePlanWriterConfig({
    context: input.context,
    pluginPath,
    toolOutputGlob: join(dataHome, "opencode", "tool-output", "*"),
    source,
  });

  // The supervisor deletes and recreates its generation root before every
  // launch. A second initialization in that root must fail closed.
  mkdirSync(root, { mode: 0o711 });
  protectedDirectory(home, protectedOwner);
  mkdirSync(openCodeConfigDir, { recursive: true, mode: 0o700 });
  for (const path of [openCodeConfigDir, configHome]) {
    chownSync(path, protectedOwner.uid, protectedOwner.gid);
    chmodSync(path, 0o555);
  }
  for (const path of [dataHome, cacheHome, stateHome, tempHome]) {
    writableDirectory(path, input.account);
  }
  mkdirSync(managed, { recursive: true, mode: 0o700 });
  writeFileSync(
    pluginPath,
    renderOpenCodePlanWriterPlugin({
      socketPath: input.socketPath,
      contextPath: input.contextPath,
      checkoutDir: input.checkoutDir,
      providerId: selection.providerAlias,
      modelId: selection.modelAlias,
      variant: input.context.writer.effort!.trim(),
    }),
    { mode: 0o400 },
  );
  writeFileSync(configPath, renderOpenCodePlanWriterConfig(config), {
    mode: 0o400,
  });
  for (const path of [configPath, pluginPath]) {
    chownSync(path, protectedOwner.uid, protectedOwner.gid);
    chmodSync(path, 0o444);
  }
  chownSync(managed, protectedOwner.uid, protectedOwner.gid);
  chmodSync(managed, 0o555);
  chownSync(root, protectedOwner.uid, protectedOwner.gid);
  chmodSync(root, 0o555);

  const env: Record<string, string> = {
    HOME: home,
    USER: "tiller",
    LOGNAME: "tiller",
    SHELL: "/bin/false",
    TMPDIR: tempHome,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_STATE_HOME: stateHome,
    GIT_CONFIG_GLOBAL: "/run/tiller-plan-writer-gitconfig",
    TILLER_PLAN_WRITER_SOCKET: input.socketPath,
    OPENCODE_CONFIG: configPath,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_TERMINAL_TITLE: "1",
    OPENCODE_ENABLE_QUESTION_TOOL: "1",
    OPENCODE_ENABLE_EXA: "1",
    OPENCODE_WEBSEARCH_PROVIDER: "exa",
  };
  copyAllowed(source, env);
  return {
    command: "opencode",
    args: [
      input.checkoutDir,
      "--agent",
      "plan",
      "--model",
      `${selection.providerAlias}/${selection.modelAlias}`,
      "--mini",
      "--no-replay",
    ],
    // OpenCode creates the real session on the first prompt. The deterministic
    // terminal identity owns publication until the plugin binds that session.
    conversationId: `opencode:${input.terminalId}`,
    env,
    providerId: selection.providerAlias,
    modelId: selection.modelAlias,
    variant: input.context.writer.effort!.trim(),
  };
}
