import { JobService } from "./job-service.mjs";
import { OpenCodeGateway } from "./opencode-gateway.mjs";
import { Policy } from "./policy.mjs";
import { JobStore } from "./store.mjs";
import { WorkspaceManager } from "./workspace.mjs";
import { BridgeError, safeError } from "./errors.mjs";

const TOOL = "opencode_job";

const toolSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["delegate", "status", "await", "result", "followup", "cancel", "disable", "enable"] },
    jobId: { type: "string" }, requestId: { type: "string" }, task: { type: "string" }, message: { type: "string" },
    repository: { type: "string" }, ref: { type: "string" }, model: { type: "string" }, waitMs: { type: "integer", minimum: 0, maximum: 25000 },
    include: { type: "object", properties: { summary: { type: "boolean" }, patch: { type: "boolean" } }, additionalProperties: false },
    consent: { type: "object", properties: { sendWorkspaceToProvider: { type: "boolean" }, returnPatchToCodex: { type: "boolean" }, enableBridge: { type: "boolean" } }, additionalProperties: false },
  },
  additionalProperties: false,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function createService() {
  const policy = Policy.fromEnv();
  const store = new JobStore(policy.stateDir);
  const gateway = new OpenCodeGateway(policy.baseUrl);
  return { service: new JobService({ store, workspace: new WorkspaceManager(policy.stateDir, policy), gateway, policy }), store };
}

let runtime;
try {
  runtime = createService();
} catch (startupError) {
  process.stderr.write(`codex-opencode-workers startup blocked: ${safeError(startupError).message}\n`);
}

async function handle(request) {
  const { id, method, params } = request;
  if (method === "notifications/initialized") return;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "codex-opencode-workers", version: "0.1.4" } } });
  }
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: [{ name: TOOL, description: "Delegate a bounded task to a local OpenCode worker, or enable or disable future delegation. This creates an external worker job, not a Codex child thread.", inputSchema: toolSchema }] } });
  }
  if (method === "tools/call") {
    if (!runtime) return error(id, -32001, "Bridge startup is blocked. Configure a loopback URL and allowed roots before use.");
    if (params?.name !== TOOL) return error(id, -32602, "Unknown tool.");
    try {
      const response = await runtime.service.execute(params.arguments || {});
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response } });
    } catch (caught) {
      const failure = safeError(caught);
      return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: failure }) }], structuredContent: { error: failure } } });
    }
  }
  if (id !== undefined) error(id, -32601, "Method not found.");
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let lineEnd;
  while ((lineEnd = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, lineEnd).trim();
    buffered = buffered.slice(lineEnd + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)).catch((caught) => process.stderr.write(`${safeError(caught).message}\n`)); }
    catch { process.stderr.write("Ignored malformed MCP message.\n"); }
  }
});

process.on("exit", () => runtime?.store.close());
