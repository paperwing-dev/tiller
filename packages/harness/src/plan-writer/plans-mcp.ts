#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  requestRepoPlanSupervisor,
  type RepoPlanCommand,
  type SupervisorResponse,
} from "./repo-plans-client.js";

const socketPath = process.env.TILLER_PLAN_WRITER_SOCKET?.trim() ?? "";
if (!socketPath) throw new Error("TILLER_PLAN_WRITER_SOCKET is required");

function toolResult(response: SupervisorResponse) {
  const text = JSON.stringify(response.body);
  return response.status >= 400
    ? { isError: true as const, content: [{ type: "text" as const, text }] }
    : { content: [{ type: "text" as const, text }] };
}

function invalidRequest(message: string) {
  return toolResult({
    status: 400,
    body: { error: message, code: "invalid_request" },
  });
}

async function callSupervisor(command: RepoPlanCommand) {
  try {
    return toolResult(await requestRepoPlanSupervisor(socketPath, command));
  } catch (error) {
    return toolResult({
      status: 503,
      body: {
        error:
          error instanceof Error
            ? error.message
            : "Plan Writer supervisor request failed.",
        code: "source_inactive",
      },
    });
  }
}

const server = new McpServer({ name: "tiller-plans", version: "1" });

server.registerTool(
  "list_plans",
  {
    description: "List plans in the current Tiller repository.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => callSupervisor({ operation: "list" }),
);

server.registerTool(
  "read_plan",
  {
    description:
      "Read one plan in the current Tiller repository, including its complete Markdown.",
    inputSchema: z.object({ planId: z.string().min(1).catch("") }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ planId }) => {
    if (!planId) return invalidRequest("planId must be a non-empty string.");
    return callSupervisor({ operation: "read", planId });
  },
);

server.registerTool(
  "create_plan",
  {
    description:
      "Create a new top-level draft plan in the current Tiller repository.",
    inputSchema: z.object({ markdown: z.string().catch("") }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ markdown }) => {
    if (!markdown)
      return invalidRequest("markdown must be a non-empty string.");
    const requestId = randomUUID();
    return callSupervisor({ operation: "create", requestId, markdown });
  },
);

server.registerTool(
  "update_plan",
  {
    description: "Compare-and-swap a plan in the current Tiller repository.",
    inputSchema: z
      .object({
        planId: z.string().min(1).catch(""),
        expectedVersion: z.number().int().positive().catch(0),
        markdown: z.string().catch(""),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ planId, expectedVersion, markdown }) => {
    if (!planId) return invalidRequest("planId must be a non-empty string.");
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return invalidRequest("expectedVersion must be a positive integer.");
    }
    if (!markdown)
      return invalidRequest("markdown must be a non-empty string.");
    return callSupervisor({
      operation: "update",
      planId,
      expectedVersion,
      markdown,
    });
  },
);

await server.connect(
  new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 8 * 1024 * 1024,
  }),
);
