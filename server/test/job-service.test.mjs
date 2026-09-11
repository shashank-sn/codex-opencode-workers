import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JobService } from "../src/job-service.mjs";
import { Policy } from "../src/policy.mjs";
import { JobStore } from "../src/store.mjs";

class FakeWorkspace {
  constructor(root) { this.root = root; this.allocations = 0; }
  async allocate(id, repository) { this.allocations += 1; return { repository, worktree: path.join(this.root, id), baseRevision: "base" }; }
  async capturePatch() { return { changedFiles: 1, patch: "diff --git a/a b/a\n+ok\n", sha256: "hash", truncated: false }; }
}

class FakeGateway {
  constructor() { this.prompts = []; this.state = "running"; }
  async createSession() { return "session-1"; }
  async promptAsync(id, directory, task, model) { this.prompts.push({ id, directory, task, model }); }
  async status() { return this.state; }
  async finalAnswer() { return "a small answer"; }
  async abort() { this.state = "idle"; }
}

test("delegate replay does not send another prompt and followup reuses the session", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ocw-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const policy = new Policy({ baseUrl: "http://127.0.0.1:4096", allowedRoots: [root], models: ["opencode-go/deepseek-v4-flash"], defaultModel: "opencode-go/deepseek-v4-flash", stateDir: path.join(root, "state") });
  const store = new JobStore(policy.stateDir);
  t.after(() => store.close());
  const workspace = new FakeWorkspace(root);
  const gateway = new FakeGateway();
  const service = new JobService({ store, workspace, gateway, policy });
  const request = { action: "delegate", requestId: "first", repository: root, task: "inspect", consent: { sendWorkspaceToProvider: true } };

  const first = await service.execute(request);
  const replay = await service.execute(request);
  assert.equal(first.job.jobId, replay.job.jobId);
  assert.equal(replay.receipt.idempotentReplay, true);
  assert.equal(workspace.allocations, 1);
  assert.equal(gateway.prompts.length, 1);

  const [parallelOne, parallelTwo] = await Promise.all([service.execute({ ...request, requestId: "parallel" }), service.execute({ ...request, requestId: "parallel" })]);
  assert.equal(parallelOne.job.jobId, parallelTwo.job.jobId);
  assert.equal(gateway.prompts.length, 2);

  gateway.state = "idle";
  const followup = await service.execute({ action: "followup", jobId: first.job.jobId, requestId: "second", message: "fix it", consent: { sendWorkspaceToProvider: true } });
  assert.equal(followup.job.state, "running");
  assert.equal(gateway.prompts.length, 3);
  assert.equal(gateway.prompts[0].id, gateway.prompts[2].id);
});

test("a rejected busy followup does not consume its idempotency key", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ocw-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const policy = new Policy({ baseUrl: "http://127.0.0.1:4096", allowedRoots: [root], models: ["opencode-go/deepseek-v4-flash"], defaultModel: "opencode-go/deepseek-v4-flash", stateDir: path.join(root, "state") });
  const store = new JobStore(policy.stateDir);
  t.after(() => store.close());
  const gateway = new FakeGateway();
  const service = new JobService({ store, workspace: new FakeWorkspace(root), gateway, policy });
  const started = await service.execute({ action: "delegate", requestId: "busy-start", repository: root, task: "inspect", consent: { sendWorkspaceToProvider: true } });
  const followup = { action: "followup", jobId: started.job.jobId, requestId: "retry-after-idle", message: "continue", consent: { sendWorkspaceToProvider: true } };
  await assert.rejects(() => service.execute(followup), { code: "JOB_BUSY" });
  gateway.state = "idle";
  const accepted = await service.execute(followup);
  assert.equal(accepted.receipt.idempotentReplay, false);
  assert.equal(gateway.prompts.length, 2);
});

test("a patch result requires separate return consent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ocw-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const policy = new Policy({ baseUrl: "http://127.0.0.1:4096", allowedRoots: [root], models: ["opencode-go/deepseek-v4-flash"], defaultModel: "opencode-go/deepseek-v4-flash", stateDir: path.join(root, "state") });
  const store = new JobStore(policy.stateDir);
  t.after(() => store.close());
  const gateway = new FakeGateway();
  gateway.state = "idle";
  const service = new JobService({ store, workspace: new FakeWorkspace(root), gateway, policy });
  const started = await service.execute({ action: "delegate", requestId: "third", repository: root, task: "inspect", consent: { sendWorkspaceToProvider: true } });

  await assert.rejects(() => service.execute({ action: "result", jobId: started.job.jobId, include: { patch: true } }), { code: "CONSENT_REQUIRED" });
  const result = await service.execute({ action: "result", jobId: started.job.jobId, include: { patch: true }, consent: { returnPatchToCodex: true } });
  assert.equal(result.result.patch.sha256, "hash");
});
