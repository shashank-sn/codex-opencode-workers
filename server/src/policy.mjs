import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "./errors.mjs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export class Policy {
  constructor({ baseUrl, allowedRoots, models, defaultModel, stateDir, configPath, config, enabled = true }) {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
      throw new BridgeError("POLICY_DENIED", "OPENCODE_WORKERS_URL must be an http loopback URL.");
    }
    if (!allowedRoots.length) {
      throw new BridgeError("POLICY_DENIED", "OPENCODE_WORKERS_ALLOWED_ROOTS must name at least one repository root.");
    }
    if (!models.length || !models.includes(defaultModel) || models.some((model) => !model.includes("/"))) {
      throw new BridgeError("POLICY_DENIED", "Each allowed model must be a provider/model ID and include the default model.");
    }
    this.baseUrl = url.toString();
    this.allowedRoots = allowedRoots.map((entry) => fs.realpathSync.native(path.resolve(entry)));
    this.models = new Set(models);
    this.defaultModel = defaultModel;
    this.stateDir = path.resolve(stateDir);
    this.configPath = configPath ? path.resolve(configPath) : null;
    this.config = config || {};
    this.enabled = enabled;
  }

  static fromEnv(env = process.env) {
    const defaultStateDir = path.join(os.homedir(), ".codex", "opencode-workers");
    const configPath = env.OPENCODE_WORKERS_CONFIG || path.join(env.OPENCODE_WORKERS_STATE_DIR || defaultStateDir, "config.json");
    let config = {};
    if (fs.existsSync(configPath)) {
      try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); }
      catch { throw new BridgeError("POLICY_DENIED", "OPENCODE_WORKERS_CONFIG must contain valid JSON."); }
    }
    const rootText = env.OPENCODE_WORKERS_ALLOWED_ROOTS || (Array.isArray(config.allowedRoots) ? config.allowedRoots.join(path.delimiter) : "");
    const allowedRoots = rootText.split(path.delimiter).filter(Boolean);
    const configuredModels = env.OPENCODE_WORKERS_MODELS || (Array.isArray(config.models) ? config.models.join(",") : "opencode-go/deepseek-v4-flash,opencode-go/deepseek-v4-pro");
    const models = configuredModels.split(",").map((model) => model.trim()).filter(Boolean);
    return new Policy({
      baseUrl: env.OPENCODE_WORKERS_URL || config.baseUrl || "http://127.0.0.1:4096",
      allowedRoots,
      models,
      defaultModel: env.OPENCODE_WORKERS_DEFAULT_MODEL || config.defaultModel || models[0],
      stateDir: env.OPENCODE_WORKERS_STATE_DIR || config.stateDir || defaultStateDir,
      configPath,
      config,
      enabled: config.enabled !== false,
    });
  }

  model(requested) {
    const model = requested || this.defaultModel;
    if (!this.models.has(model)) {
      throw new BridgeError("POLICY_DENIED", "That OpenCode model is not allowed by this bridge.");
    }
    return model;
  }

  rootAllowed(repository) {
    let candidate;
    try { candidate = fs.realpathSync.native(path.resolve(repository)); }
    catch { return false; }
    return this.allowedRoots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
  }

  requireDelegate(input) {
    if (!this.enabled) {
      throw new BridgeError("POLICY_DENIED", "The OpenCode worker bridge is disabled.");
    }
    if (!input?.requestId || typeof input.requestId !== "string") {
      throw new BridgeError("INVALID_INPUT", "delegate requires a requestId.");
    }
    if (!input.task || typeof input.task !== "string" || input.task.trim().length > 24_000) {
      throw new BridgeError("INVALID_INPUT", "delegate requires a task up to 24,000 characters.");
    }
    if (!input.repository || typeof input.repository !== "string" || !path.isAbsolute(input.repository)) {
      throw new BridgeError("INVALID_INPUT", "delegate requires an absolute repository path.");
    }
    if (!this.rootAllowed(input.repository)) {
      throw new BridgeError("POLICY_DENIED", "The repository is outside OPENCODE_WORKERS_ALLOWED_ROOTS.");
    }
    if (input.consent?.sendWorkspaceToProvider !== true) {
      throw new BridgeError("CONSENT_REQUIRED", "delegate requires sendWorkspaceToProvider: true.");
    }
  }

  requireFollowup(input) {
    if (!input?.requestId || typeof input.requestId !== "string" || !input?.jobId || !input?.message) {
      throw new BridgeError("INVALID_INPUT", "followup requires jobId, requestId, and message.");
    }
    if (input.consent?.sendWorkspaceToProvider !== true) {
      throw new BridgeError("CONSENT_REQUIRED", "followup requires sendWorkspaceToProvider: true.");
    }
  }

  requireToggle(input, enabled) {
    if (!input?.requestId || typeof input.requestId !== "string") {
      throw new BridgeError("INVALID_INPUT", `${enabled ? "enable" : "disable"} requires a requestId.`);
    }
    if (enabled && input.consent?.enableBridge !== true) {
      throw new BridgeError("CONSENT_REQUIRED", "enable requires enableBridge: true.");
    }
  }

  setEnabled(enabled) {
    if (!this.configPath) {
      throw new BridgeError("POLICY_DENIED", "The bridge needs a local config file to change its enabled state.");
    }
    this.config.enabled = enabled;
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 });
    this.enabled = enabled;
  }

  redact(value) {
    return String(value || "")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
      .replace(/\b(?:api[_-]?key|authorization)\s*[:=]\s*[^\s]+/gi, "[REDACTED]")
      .slice(0, 32_000);
  }
}
