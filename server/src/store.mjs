import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BridgeError } from "./errors.mjs";

export class JobStore {
  constructor(stateDir) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(stateDir, "jobs.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY, state TEXT NOT NULL, repository TEXT NOT NULL,
        worktree TEXT, base_revision TEXT, model TEXT NOT NULL, session_id TEXT,
        request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, failure_code TEXT, failure_message TEXT,
        summary TEXT, patch TEXT, patch_sha256 TEXT, patch_truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS operations (
        request_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, payload_hash TEXT NOT NULL, action TEXT NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  get(jobId) {
    return this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId);
  }

  getOperation(requestId) {
    return this.db.prepare("SELECT * FROM operations WHERE request_id = ?").get(requestId);
  }

  assertReplay(requestId, payloadHash) {
    const found = this.getOperation(requestId);
    if (!found) return null;
    if (found.payload_hash !== payloadHash) {
      throw new BridgeError("IDEMPOTENCY_CONFLICT", "This requestId was already used for different input.");
    }
    return this.get(found.job_id);
  }

  create(record) {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO jobs (job_id,state,repository,worktree,base_revision,model,session_id,request_id,request_hash,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        record.jobId, record.state, record.repository, record.worktree || null, record.baseRevision || null,
        record.model, record.sessionId || null, record.requestId, record.requestHash, now, now,
      );
      this.db.prepare("INSERT INTO operations (request_id,job_id,payload_hash,action) VALUES (?,?,?,?)")
        .run(record.requestId, record.jobId, record.requestHash, "delegate");
      this.db.exec("COMMIT");
      return this.get(record.jobId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  rememberOperation({ requestId, jobId, payloadHash, action }) {
    const existing = this.assertReplay(requestId, payloadHash);
    if (existing) return { replay: true, job: existing };
    this.db.prepare("INSERT INTO operations (request_id,job_id,payload_hash,action) VALUES (?,?,?,?)")
      .run(requestId, jobId, payloadHash, action);
    return { replay: false, job: null };
  }

  update(jobId, patch) {
    const allowed = new Set(["state", "worktree", "base_revision", "session_id", "failure_code", "failure_message", "summary", "patch", "patch_sha256", "patch_truncated"]);
    const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
    if (!entries.length) return this.get(jobId);
    const fragments = entries.map(([key]) => `${key} = ?`).join(", ");
    this.db.prepare(`UPDATE jobs SET ${fragments}, updated_at = ? WHERE job_id = ?`)
      .run(...entries.map(([, value]) => value), Date.now(), jobId);
    return this.get(jobId);
  }
}
