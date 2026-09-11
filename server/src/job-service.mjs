import crypto from "node:crypto";
import { BridgeError, safeError } from "./errors.mjs";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "orphaned"]);
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const jobId = () => `ocj_${crypto.randomUUID()}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class JobService {
  constructor({ store, workspace, gateway, policy }) {
    this.store = store;
    this.workspace = workspace;
    this.gateway = gateway;
    this.policy = policy;
    this.locks = new Map();
  }

  async execute(input) {
    if (!input?.action || typeof input.action !== "string") {
      throw new BridgeError("INVALID_INPUT", "opencode_job requires an action.");
    }
    if (input.action === "delegate") {
      const requestId = typeof input.requestId === "string" ? input.requestId : "invalid-delegate";
      return this.withLock(`request:${requestId}`, () => this.delegate(input));
    }
    if (input.action === "disable" || input.action === "enable") {
      return this.toggle(input);
    }
    if (!input.jobId || typeof input.jobId !== "string") {
      throw new BridgeError("INVALID_INPUT", `${input.action} requires a jobId.`);
    }
    return this.withLock(input.jobId, async () => {
      if (input.action === "status") return this.reply(await this.reconcile(this.requireJob(input.jobId)));
      if (input.action === "await") return this.await(input);
      if (input.action === "result") return this.result(input);
      if (input.action === "followup") return this.followup(input);
      if (input.action === "cancel") return this.cancel(input);
      throw new BridgeError("INVALID_INPUT", "Unknown opencode_job action.");
    });
  }

  async toggle(input) {
    const enabled = input.action === "enable";
    this.policy.requireToggle(input, enabled);
    this.policy.setEnabled(enabled);
    return {
      receipt: { action: input.action, idempotentReplay: false, observedAt: new Date().toISOString() },
      bridge: { enabled },
    };
  }

  async delegate(input) {
    this.policy.requireDelegate(input);
    const requestHash = hash({ action: "delegate", task: input.task, repository: input.repository, ref: input.ref || "HEAD", model: input.model || null, consent: input.consent });
    const replay = this.store.assertReplay(input.requestId, requestHash);
    if (replay) return this.reply(replay, { action: "delegate", replay: true });

    const model = this.policy.model(input.model);
    const id = jobId();
    this.store.create({ jobId: id, state: "creating", repository: input.repository, model, requestId: input.requestId, requestHash });
    try {
      const lease = await this.workspace.allocate(id, input.repository, input.ref || "HEAD");
      let record = this.store.update(id, { worktree: lease.worktree, base_revision: lease.baseRevision, state: "dispatching" });
      const sessionId = await this.gateway.createSession(lease.worktree, `Codex external worker ${id}`);
      record = this.store.update(id, { session_id: sessionId });
      await this.gateway.promptAsync(sessionId, lease.worktree, input.task, model);
      record = this.store.update(id, { state: "running" });
      return this.reply(record, { action: "delegate", replay: false });
    } catch (error) {
      const failure = safeError(error);
      const record = this.store.update(id, { state: "failed", failure_code: failure.code, failure_message: failure.message });
      return this.reply(record, { action: "delegate", replay: false });
    }
  }

  async followup(input) {
    this.policy.requireFollowup(input);
    const record = await this.reconcile(this.requireJob(input.jobId));
    if (record.state !== "succeeded" || !record.session_id || !record.worktree) {
      throw new BridgeError("JOB_BUSY", "followup is allowed only after the recorded worker is idle.");
    }
    const requestHash = hash({ action: "followup", jobId: input.jobId, message: input.message, consent: input.consent });
    const replay = this.store.rememberOperation({ requestId: input.requestId, jobId: record.job_id, payloadHash: requestHash, action: "followup" });
    if (replay.replay) return this.reply(replay.job, { action: "followup", replay: true });
    try {
      await this.gateway.promptAsync(record.session_id, record.worktree, input.message, record.model);
      return this.reply(this.store.update(record.job_id, { state: "running", summary: null, failure_code: null, failure_message: null }), { action: "followup", replay: false });
    } catch (error) {
      const failure = safeError(error);
      return this.reply(this.store.update(record.job_id, { state: "failed", failure_code: failure.code, failure_message: failure.message }), { action: "followup", replay: false });
    }
  }

  async cancel(input) {
    if (!input.requestId || typeof input.requestId !== "string") throw new BridgeError("INVALID_INPUT", "cancel requires a requestId.");
    const record = this.requireJob(input.jobId);
    const requestHash = hash({ action: "cancel", jobId: input.jobId });
    const replay = this.store.rememberOperation({ requestId: input.requestId, jobId: record.job_id, payloadHash: requestHash, action: "cancel" });
    if (replay.replay) return this.reply(replay.job, { action: "cancel", replay: true });
    if (TERMINAL.has(record.state)) return this.reply(record, { action: "cancel", replay: false });
    if (!record.session_id || !record.worktree) {
      return this.reply(this.store.update(record.job_id, { state: "orphaned", failure_code: "SESSION_LOST", failure_message: "The worker session was not recorded." }), { action: "cancel", replay: false });
    }
    this.store.update(record.job_id, { state: "cancel_requested" });
    try {
      await this.gateway.abort(record.session_id, record.worktree);
      return this.reply(this.store.update(record.job_id, { state: "cancelled" }), { action: "cancel", replay: false });
    } catch (error) {
      const failure = safeError(error);
      return this.reply(this.store.update(record.job_id, { state: "failed", failure_code: failure.code, failure_message: failure.message }), { action: "cancel", replay: false });
    }
  }

  async await(input) {
    const budget = Math.min(Math.max(Number(input.waitMs || 0), 0), 25_000);
    const until = Date.now() + budget;
    let record = await this.reconcile(this.requireJob(input.jobId));
    while (!TERMINAL.has(record.state) && Date.now() < until) {
      await delay(Math.min(1_000, until - Date.now()));
      record = await this.reconcile(this.requireJob(input.jobId));
    }
    return this.reply(record, { action: "await", replay: false });
  }

  async result(input) {
    const waited = await this.await({ action: "await", jobId: input.jobId, waitMs: input.waitMs || 0 });
    const record = this.requireJob(input.jobId);
    const include = input.include || { summary: true };
    const result = {};
    if (include.summary && record.summary) result.summary = record.summary;
    if (include.patch) {
      if (input.consent?.returnPatchToCodex !== true) {
        throw new BridgeError("CONSENT_REQUIRED", "result with a patch requires returnPatchToCodex: true.");
      }
      if (record.patch) result.patch = { unifiedDiff: record.patch, sha256: record.patch_sha256, truncated: Boolean(record.patch_truncated), baseRevision: record.base_revision };
    }
    return { ...waited, result };
  }

  async reconcile(record) {
    if (TERMINAL.has(record.state) || record.state === "cancel_requested") return record;
    if (!record.session_id || !record.worktree) {
      return this.store.update(record.job_id, { state: "orphaned", failure_code: "SESSION_LOST", failure_message: "The worker session could not be recovered." });
    }
    try {
      const state = await this.gateway.status(record.session_id, record.worktree);
      if (state === "running" || state === "retrying") return this.store.update(record.job_id, { state });
      if (state === "missing") return this.store.update(record.job_id, { state: "orphaned", failure_code: "SESSION_LOST", failure_message: "The recorded OpenCode session is unavailable." });
      if (state === "failed") return this.store.update(record.job_id, { state: "failed", failure_code: "WORKER_ERROR", failure_message: "OpenCode reported a worker failure." });
      const [summary, patch] = await Promise.all([
        this.gateway.finalAnswer(record.session_id, record.worktree),
        this.workspace.capturePatch(record.worktree, record.base_revision),
      ]);
      return this.store.update(record.job_id, {
        state: "succeeded", summary: this.policy.redact(summary), patch: this.policy.redact(patch.patch),
        patch_sha256: patch.sha256, patch_truncated: patch.truncated ? 1 : 0,
      });
    } catch (error) {
      const failure = safeError(error);
      return this.store.update(record.job_id, { state: "retrying", failure_code: failure.code, failure_message: failure.message });
    }
  }

  requireJob(jobId) {
    const record = this.store.get(jobId);
    if (!record) throw new BridgeError("NOT_FOUND", "Unknown OpenCode worker job.");
    return record;
  }

  async withLock(jobId, operation) {
    const prior = this.locks.get(jobId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = prior.then(() => current);
    this.locks.set(jobId, queued);
    await prior;
    try { return await operation(); } finally { release(); if (this.locks.get(jobId) === queued) this.locks.delete(jobId); }
  }

  reply(record, receipt = { action: "status", replay: false }) {
    return {
      receipt: { action: receipt.action, idempotentReplay: Boolean(receipt.replay), observedAt: new Date().toISOString() },
      job: {
        jobId: record.job_id, state: record.state, model: record.model,
        baseRevision: record.base_revision || undefined, createdAt: new Date(record.created_at).toISOString(),
        updatedAt: new Date(record.updated_at).toISOString(),
        failure: record.failure_code ? { code: record.failure_code, message: record.failure_message } : undefined,
      },
    };
  }
}
