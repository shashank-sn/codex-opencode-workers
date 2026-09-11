import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeGateway } from "../src/opencode-gateway.mjs";

test("gateway sends directory on every OpenCode request, including mutations", async (t) => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    const request = { method: options.method, url: new URL(url), body: options.body };
    calls.push(request);
    if (request.method === "POST" && request.url.pathname === "/session") return response({ id: "session-1" });
    if (request.url.pathname.includes("prompt_async")) return new Response(null, { status: 204 });
    if (request.url.pathname === "/session/status") return response({ "session-1": { type: "idle" } });
    if (request.url.pathname.includes("/message")) return response([{ info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] }]);
    if (request.url.pathname.includes("/abort")) return response(true);
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  };
  const gateway = new OpenCodeGateway("http://127.0.0.1:4096", fakeFetch);
  const directory = "/tmp/bridge-worktree";

  const id = await gateway.createSession(directory, "job");
  await gateway.promptAsync(id, directory, "inspect", "opencode-go/deepseek-v4-flash");
  assert.equal(await gateway.status(id, directory), "idle");
  assert.equal(await gateway.finalAnswer(id, directory), "done");
  await gateway.abort(id, directory);

  assert.equal(calls.length, 5);
  for (const call of calls) assert.equal(call.url.searchParams.get("directory"), directory, `${call.method} ${call.url.pathname}`);
  const prompt = calls.find((call) => call.url.pathname.includes("prompt_async"));
  assert.deepEqual(JSON.parse(prompt.body), { model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" }, parts: [{ type: "text", text: "inspect" }] });
});

function response(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

test("gateway recognizes a completed session when OpenCode omits it from the active status map", async () => {
  const gateway = new OpenCodeGateway("http://127.0.0.1:4096", async (url) => {
    const request = new URL(url);
    if (request.pathname === "/session/status") return response({});
    if (request.pathname.includes("/message")) {
      return response([{ info: { role: "assistant", time: { completed: 1 } }, parts: [{ type: "text", text: "done" }] }]);
    }
    throw new Error(`unexpected request ${request}`);
  });

  assert.equal(await gateway.status("session-1", "/tmp/bridge-worktree"), "idle");
});
