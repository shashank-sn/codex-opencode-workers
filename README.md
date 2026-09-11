# Codex OpenCode Workers

This is a local Codex plugin that exposes one MCP tool, `opencode_job`. It delegates a bounded task to a locally running OpenCode server with an allowed OpenCode model already configured locally.

It is deliberately an **external worker** bridge. It does not create a native Codex subagent thread, does not expose OpenCode transcripts or credentials, and does not use OpenCode as a model provider for the whole Codex chat.

## Before installation

Start OpenCode on loopback and create the bridge's non-secret local configuration:

```sh
opencode serve --hostname 127.0.0.1 --port 4096

mkdir -p ~/.codex/opencode-workers
cp config.example.json ~/.codex/opencode-workers/config.json
```

Edit `~/.codex/opencode-workers/config.json` to set an explicit loopback URL and allowed repository roots. It contains only non-secret bridge policy and is readable by the plugin on every startup. You can instead set `OPENCODE_WORKERS_CONFIG` to another absolute config path.

The template defaults to OpenCode Go's DeepSeek models, with `opencode-go/deepseek-v4-flash` selected. Override it only with provider/model IDs that your existing OpenCode configuration exposes:

```sh
export OPENCODE_WORKERS_MODELS=opencode-go/deepseek-v4-flash,opencode-go/deepseek-v4-pro
export OPENCODE_WORKERS_DEFAULT_MODEL=opencode-go/deepseek-v4-flash
```

Credentials stay in OpenCode. This plugin does not read `auth.json`, accept API keys, or forward environment secrets.

## Tool contract

`opencode_job` accepts an `action`:

- `delegate`: requires a unique `requestId`, an allowed repository root, a task, and `sendWorkspaceToProvider: true`. It creates a detached worktree and sends an async prompt to OpenCode.
- `status` and `await`: reconcile the stored job with OpenCode without returning its transcript.
- `result`: returns an opt-in bounded summary and/or revision-bound patch. Patch return additionally requires `returnPatchToCodex: true`.
- `followup`: sends a new prompt only to the recorded idle session; it cannot switch workspace or model.
- `cancel`: idempotently aborts that recorded session.
- `disable`: immediately blocks future `delegate` requests without contacting a provider. Existing jobs can still be inspected or cancelled.
- `enable`: turns delegation back on, but requires `enableBridge: true` consent.

The bridge stores job IDs, state, hashes, and patch artifacts in SQLite under `OPENCODE_WORKERS_STATE_DIR` (or `~/.codex/opencode-workers`). It intentionally does not persist raw prompt text, provider credentials, worker logs, or full transcripts.

The `enabled` property in `~/.codex/opencode-workers/config.json` is a persistent emergency stop. Set it to `false`, or call `opencode_job` with `action: "disable"`, to prevent new provider requests. It does not abort a job that was already dispatched; use `cancel` for that.

## Safety boundary

Every delegated task can cause the configured external provider to receive the task and files OpenCode chooses to read. A git worktree prevents accidental checkout cross-contamination, but it is not an operating-system sandbox. Use only trusted local repositories and do not approve workspaces containing material you cannot send to the selected provider.

## Validation

```sh
npm test
```

The tests use a fake local OpenCode HTTP server. They do not start OpenCode, read authentication state, contact DeepSeek, or mutate your repositories outside temporary test fixtures.

## Model boundary

`opencode_job` creates an external OpenCode Go worker. It cannot replace the model used by native Codex child tasks or ChatGPT tasks; those runtimes select their own models. Use this bridge when you specifically want the external DeepSeek worker.
