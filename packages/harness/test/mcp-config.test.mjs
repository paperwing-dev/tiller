import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MCP_CONFIG_DIST = path.resolve(import.meta.dirname, "../dist/mcp-config.js");

async function loadModule() {
  return await import(pathToFileURL(MCP_CONFIG_DIST).href);
}

test("readManagedMcpServersFromEnv parses URL-only Tiller-managed entries", async () => {
  const { readManagedMcpServersFromEnv } = await loadModule();
  const servers = readManagedMcpServersFromEnv({
    TILLER_MCP_SERVERS_JSON: JSON.stringify([
      {
        id: "tiller_docs",
        url: "https://DOCS.EXAMPLE.COM:443/mcp",
        envHttpHeaders: { Authorization: "MCP_SECRET" },
      },
    ]),
  });

  assert.deepEqual(servers, [
    {
      id: "tiller_docs",
      url: "https://docs.example.com/mcp",
    },
  ]);
  assert.throws(() => readManagedMcpServersFromEnv({
    TILLER_MCP_SERVERS_JSON: JSON.stringify([
      { id: "client_docs", url: "https://docs.example.com/mcp" },
    ]),
  }), /not Tiller-managed/);
});

test("readManagedMcpServersFromEnv accepts only public credential-free HTTPS URLs", async () => {
  const { readManagedMcpServersFromEnv } = await loadModule();
  const invalidUrls = [
    "http://docs.example.com/mcp",
    "http://host.docker.internal:8788/api/mcp/cloudflare",
    "https://user:pass@docs.example.com/mcp",
    "https://docs.example.com/mcp?token=secret",
    "https://docs.example.com/mcp?",
    "https://docs.example.com/mcp#fragment",
    "https://docs.example.com/mcp#",
    "https://127.0.0.1/mcp",
    "https://[::1]/mcp",
    "https://localhost/mcp",
    "https://service.internal/mcp",
    "https://service.local/mcp",
  ];

  for (const url of invalidUrls) {
    assert.throws(() => readManagedMcpServersFromEnv({
      TILLER_MCP_SERVERS_JSON: JSON.stringify([{ id: "tiller_docs", url }]),
    }), /MCP server tiller_docs URL/);
  }
});

test("buildManagedClaudeMcpServers replaces only Tiller-managed project entries", async () => {
  const { buildManagedClaudeMcpServers } = await loadModule();
  assert.deepEqual(buildManagedClaudeMcpServers({
    custom_docs: { type: "http", url: "https://custom.example.com/mcp" },
    tiller_old: { type: "http", url: "https://old.example.com/mcp" },
  }, [
    { id: "tiller_docs", url: "https://docs.example.com/mcp" },
  ]), {
    custom_docs: { type: "http", url: "https://custom.example.com/mcp" },
    tiller_docs: {
      type: "http",
      url: "https://docs.example.com/mcp",
    },
  });
});

test("buildCodexMcpConfigOverrides emits URL-only TOML overrides", async () => {
  const { buildCodexMcpConfigOverrides } = await loadModule();
  assert.deepEqual(buildCodexMcpConfigOverrides([
    { id: "tiller_docs", url: "https://docs.example.com/mcp" },
  ]), [
    'mcp_servers.tiller_docs={ url = "https://docs.example.com/mcp" }',
  ]);
});

test("applyManagedOpenCodeMcpConfig preserves unmanaged entries and disables OAuth", async () => {
  const { applyManagedOpenCodeMcpConfig } = await loadModule();
  const merged = JSON.parse(applyManagedOpenCodeMcpConfig(JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    mcp: {
      custom_docs: { type: "remote", url: "https://custom.example.com/mcp", enabled: true },
      tiller_old: { type: "remote", url: "https://old.example.com/mcp", enabled: true },
    },
  }), [
    { id: "tiller_docs", url: "https://docs.example.com/mcp" },
  ]));

  assert.deepEqual(merged.mcp, {
    custom_docs: { type: "remote", url: "https://custom.example.com/mcp", enabled: true },
    tiller_docs: {
      type: "remote",
      url: "https://docs.example.com/mcp",
      enabled: true,
      oauth: false,
    },
  });
});
