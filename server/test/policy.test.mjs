import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Policy } from "../src/policy.mjs";

test("policy loads non-secret bridge settings from a local config file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ocw-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, "config.json");
  await fs.writeFile(config, JSON.stringify({ baseUrl: "http://127.0.0.1:4096", enabled: true, allowedRoots: [root], models: ["opencode-go/deepseek-v4-flash"], defaultModel: "opencode-go/deepseek-v4-flash", stateDir: path.join(root, "state") }));
  const policy = Policy.fromEnv({ OPENCODE_WORKERS_CONFIG: config });
  assert.equal(policy.model(), "opencode-go/deepseek-v4-flash");
  assert.equal(policy.rootAllowed(root), true);
  policy.setEnabled(false);
  assert.equal(JSON.parse(await fs.readFile(config, "utf8")).enabled, false);
  assert.throws(() => policy.requireDelegate({ action: "delegate", requestId: "blocked", repository: root, task: "inspect", consent: { sendWorkspaceToProvider: true } }), { code: "POLICY_DENIED" });
  policy.setEnabled(true);
  assert.equal(JSON.parse(await fs.readFile(config, "utf8")).enabled, true);
});
