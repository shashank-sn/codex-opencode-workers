import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Policy } from "../src/policy.mjs";
import { WorkspaceManager } from "../src/workspace.mjs";

const exec = promisify(execFile);

test("workspace manager creates an owned detached worktree and revision-bound patch", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ocw-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "note.txt"), "before\n");
  await git(root, ["add", "note.txt"]);
  await git(root, ["commit", "-m", "initial"]);

  const stateDir = path.join(root, "state");
  const policy = new Policy({ baseUrl: "http://127.0.0.1:4096", allowedRoots: [root], models: ["opencode-go/deepseek-v4-flash"], defaultModel: "opencode-go/deepseek-v4-flash", stateDir });
  const manager = new WorkspaceManager(stateDir, policy);
  const lease = await manager.allocate("ocj_test", root);
  assert.notEqual(lease.worktree, root);
  await fs.writeFile(path.join(lease.worktree, "note.txt"), "after\n");
  const patch = await manager.capturePatch(lease.worktree, lease.baseRevision);
  assert.equal(patch.changedFiles, 1);
  assert.match(patch.patch, /-before/);
  assert.match(patch.patch, /\+after/);
  assert.match(patch.sha256, /^[a-f0-9]{64}$/);
});

async function git(cwd, args) {
  await exec("git", args, { cwd });
}
