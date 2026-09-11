import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("MCP server advertises the single bounded worker tool", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ocw-mcp-"));
  const child = spawn(process.execPath, ["server/src/index.mjs"], {
    cwd: path.resolve("."),
    env: { ...process.env, OPENCODE_WORKERS_URL: "http://127.0.0.1:4096", OPENCODE_WORKERS_ALLOWED_ROOTS: root, OPENCODE_WORKERS_STATE_DIR: path.join(root, "state") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => { child.kill(); await fs.rm(root, { recursive: true, force: true }); });
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => lines.push(...chunk.split("\n").filter(Boolean).map(JSON.parse)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  await waitFor(() => lines.some((line) => line.id === 2));
  const tools = lines.find((line) => line.id === 2).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["opencode_job"]);
  assert.deepEqual(tools[0].inputSchema.properties.action.enum, ["delegate", "status", "await", "result", "followup", "cancel", "disable", "enable"]);
});

async function waitFor(predicate) {
  const until = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("MCP response timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
