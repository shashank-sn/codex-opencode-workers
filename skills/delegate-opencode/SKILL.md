---
name: delegate-opencode-worker
description: Delegate a bounded task to a local OpenCode Go DeepSeek worker through the opencode_job MCP tool.
---

# Delegate to OpenCode

Use `opencode_job` when the user asks to delegate a bounded task to their local OpenCode Go worker. Omit `model` to use the configured OpenCode Go DeepSeek default. This is an external worker, not a native Codex subagent.

Before `delegate`, state that the task and files OpenCode may read can be sent to the configured external provider. Require the tool's explicit consent fields; never invent consent.

Use a fresh `requestId` for each state-changing action. Do not pass API keys, OpenCode credentials, arbitrary shell commands, or arbitrary model/provider identifiers. Report the returned job ID and state. Poll through `status` or bounded `await`; use `result` only when the caller authorizes returning a summary or patch.

Never call this tool for browser, desktop, audio, image, video, or credential tasks. Do not describe the resulting job as a Codex child task.

If the user asks to stop external delegation, call `disable` with a fresh requestId. `disable` blocks future provider requests but does not abort a worker that was already dispatched; use `cancel` for that job. Only call `enable` when the user explicitly authorizes re-enabling the bridge, and include `enableBridge: true`.
