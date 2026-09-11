import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { BridgeError } from "./errors.mjs";

const exec = promisify(execFile);

async function git(cwd, args, maxBuffer = 1_500_000) {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer });
    return stdout;
  } catch {
    throw new BridgeError("WORKSPACE_ERROR", "The repository operation could not be completed.");
  }
}

export class WorkspaceManager {
  constructor(stateDir, policy) {
    this.worktreeBase = path.join(stateDir, "worktrees");
    this.policy = policy;
  }

  async allocate(jobId, repository, ref = "HEAD") {
    const root = await fs.realpath(repository).catch(() => null);
    if (!root || !this.policy.rootAllowed(root)) {
      throw new BridgeError("POLICY_DENIED", "The repository is not an allowed canonical path.");
    }
    const gitRoot = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
    if (gitRoot !== root) {
      throw new BridgeError("INVALID_INPUT", "repository must be the repository root, not a nested directory.");
    }
    const baseRevision = (await git(root, ["rev-parse", ref])).trim();
    const worktree = path.join(this.worktreeBase, jobId);
    await fs.mkdir(this.worktreeBase, { recursive: true, mode: 0o700 });
    await git(root, ["worktree", "add", "--detach", worktree, baseRevision]);
    return { repository: root, worktree: await fs.realpath(worktree), baseRevision };
  }

  async capturePatch(worktree, baseRevision) {
    const changed = (await git(worktree, ["status", "--porcelain"])).trim().split("\n").filter(Boolean).length;
    let patch = await git(worktree, ["diff", "--no-ext-diff", baseRevision], 1_500_000);
    const truncated = Buffer.byteLength(patch) > 500_000;
    if (truncated) patch = patch.slice(0, 500_000);
    return {
      changedFiles: changed,
      patch,
      sha256: crypto.createHash("sha256").update(patch).digest("hex"),
      truncated,
    };
  }
}
