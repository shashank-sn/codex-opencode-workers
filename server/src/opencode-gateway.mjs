import { BridgeError } from "./errors.mjs";

export class OpenCodeGateway {
  constructor(baseUrl, fetchImpl = fetch) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
  }

  url(pathname, directory) {
    const url = new URL(pathname, this.baseUrl);
    url.searchParams.set("directory", directory);
    return url;
  }

  async request(method, pathname, directory, body) {
    const response = await this.fetch(this.url(pathname, directory), {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new BridgeError("OPENCODE_UNAVAILABLE", `OpenCode returned ${response.status}.`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async createSession(directory, title) {
    const session = await this.request("POST", "/session", directory, { title });
    const id = session?.id || session?.sessionID;
    if (!id) throw new BridgeError("OPENCODE_UNAVAILABLE", "OpenCode did not return a session id.");
    return id;
  }

  promptAsync(sessionId, directory, task, model) {
    const [providerID, modelID] = model.split("/", 2);
    return this.request("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, directory, {
      model: { providerID, modelID },
      parts: [{ type: "text", text: task }],
    });
  }

  async status(sessionId, directory) {
    const statuses = await this.request("GET", "/session/status", directory);
    const raw = statuses?.[sessionId];
    const state = typeof raw === "string" ? raw : raw?.type || raw?.status;
    if (state === "idle") return "idle";
    if (state === "retry") return "retrying";
    if (state === "busy" || state === "running") return "running";
    if (raw) return "failed";

    const assistant = this.assistantMessage(await this.messages(sessionId, directory));
    if (!assistant) return "running";
    if (assistant.info?.error) return "failed";
    if (assistant.info?.time?.completed || assistant.parts?.some((part) => part.type === "step-finish")) return "idle";
    return "running";
  }

  async abort(sessionId, directory) {
    await this.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`, directory);
  }

  async finalAnswer(sessionId, directory) {
    const assistant = this.assistantMessage(await this.messages(sessionId, directory));
    const parts = assistant?.parts || [];
    return parts.map((part) => part.text || part.content || "").filter(Boolean).join("\n");
  }

  async messages(sessionId, directory) {
    return this.request("GET", `/session/${encodeURIComponent(sessionId)}/message`, directory);
  }

  assistantMessage(messages) {
    const values = Array.isArray(messages) ? messages : messages?.data || [];
    return values.filter((entry) => entry?.info?.role === "assistant").at(-1);
  }
}
