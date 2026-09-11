# codex opencode workers

codex has native subagents. opencode has local sessions and the models you already configured there. those are different systems, and pretending otherwise makes a mess.

this plugin gives codex one deliberate way to hand a bounded job to a local opencode worker. it creates a detached git worktree, starts an opencode session against that worktree, and keeps a small local ledger so you can check, resume, cancel, or retrieve the result later.

the bridge is small on purpose. it does not turn opencode into codex's global model provider. it does not manufacture a native codex child task. it does not read your opencode credentials. it does not spray worker transcripts back into the chat.

it is an external worker bridge. that distinction matters.

## what it does

the plugin exposes one mcp tool: `opencode_job`.

use it to:

- delegate one bounded task to a locally running opencode session
- check a recorded job's state or wait for it for a bounded time
- retrieve a bounded worker summary or a revision-bound patch
- send a follow-up to the same completed session
- cancel a job
- disable new delegation immediately, then explicitly re-enable it later

every delegate request needs an explicit `sendWorkspaceToProvider: true` consent flag. requesting a patch needs another explicit consent flag. that is not ceremony. opencode and its configured provider may read files in the worktree you hand it.

## the shape of the system

```text
codex
  │
  │ MCP: opencode_job
  ▼
codex-opencode-workers
  ├── policy gate
  │   ├── loopback-only opencode URL
  │   ├── allowed repository roots
  │   ├── allowed provider/model IDs
  │   └── explicit consent checks
  ├── SQLite job ledger
  │   └── request ID → job → session → worktree → receipt
  ├── detached git worktree
  │   └── isolated execution surface for one job
  └── local opencode HTTP server
      └── configured external model provider
```

the plugin starts no processes. start opencode yourself. the bridge only talks to an `http` loopback address (`127.0.0.1`, `localhost`, or `::1`). it rejects remote endpoints before any job is sent.

the ledger lives under `~/.codex/opencode-workers` by default. it stores job ids, state, content hashes, session ids, worktree paths, a redacted bounded summary, and a revision-bound patch. it deliberately does not store raw task text, provider credentials, full worker logs, or full transcripts.

## requirements

- macos, linux, or another environment where node.js and git work
- node.js 24 or newer
- a local opencode installation
- an existing opencode provider/model configuration
- a git repository you trust enough to let the configured provider read
- codex with local plugin support

this repository ships defaults for opencode go's deepseek model ids. they are policy defaults, not credentials and not a promise that a provider is available on your machine.

## setup

### 1. start opencode on loopback

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

keep this process running while the bridge is in use. the bridge will not launch, restart, or kill it.

### 2. clone the plugin and install its dependencies

```sh
git clone https://github.com/shashank-sn/codex-opencode-workers.git ~/plugins/codex-opencode-workers
cd ~/plugins/codex-opencode-workers
npm install
```

the repository has no runtime npm dependencies today. running `npm install` still gives you a normal local package setup and a lockfile if future versions add one.

### 3. create the bridge policy

```sh
mkdir -p ~/.codex/opencode-workers
cp config.example.json ~/.codex/opencode-workers/config.json
```

edit `~/.codex/opencode-workers/config.json`. set `allowedRoots` to the absolute paths that may be delegated. leave the URL on loopback.

```json
{
  "baseUrl": "http://127.0.0.1:4096",
  "enabled": true,
  "allowedRoots": ["/Users/you/src/a-repository-you-trust"],
  "models": ["opencode-go/deepseek-v4-flash"],
  "defaultModel": "opencode-go/deepseek-v4-flash"
}
```

you can override the config location with `OPENCODE_WORKERS_CONFIG`. the other supported overrides are `OPENCODE_WORKERS_URL`, `OPENCODE_WORKERS_ALLOWED_ROOTS`, `OPENCODE_WORKERS_STATE_DIR`, `OPENCODE_WORKERS_MODELS`, and `OPENCODE_WORKERS_DEFAULT_MODEL`.

do not put api keys in this file. credentials remain in opencode's own configuration; this plugin neither reads `auth.json` nor accepts provider keys.

### 4. register the local plugin

add the cloned directory to your local codex marketplace, then install it:

```sh
codex plugin add codex-opencode-workers@personal
```

the normal personal-marketplace layout keeps the source at `~/plugins/codex-opencode-workers/` and registers it in `~/.agents/plugins/marketplace.json`. start a new codex task after installation so the MCP tool and skill reload.

if you prefer an archive instead of a clone, run `npm run pack`, extract the resulting archive into that trusted plugin source directory, and register it the same way. [packaging details](PACKAGING.md) cover the exact contents.

## using the tool

the `delegate-opencode-worker` skill helps codex use the tool safely. the first call needs a fresh `requestId`, an allowed repository root, a bounded task, and explicit consent.

```json
{
  "action": "delegate",
  "requestId": "docs-audit-2026-09-11-01",
  "repository": "/Users/you/src/a-repository-you-trust",
  "task": "inspect the README for setup mistakes. do not edit files. return the concrete findings.",
  "consent": {
    "sendWorkspaceToProvider": true
  }
}
```

the response contains a job id and a receipt. use that job id for the rest of the lifecycle.

```json
{ "action": "await", "jobId": "ocj_...", "waitMs": 25000 }
```

```json
{
  "action": "result",
  "jobId": "ocj_...",
  "include": { "summary": true, "patch": true },
  "consent": { "returnPatchToCodex": true }
}
```

`followup` only targets the recorded, idle session. it cannot switch repositories or models. `cancel` is idempotent. repeat the same state-changing request with the same request ID and the bridge returns the saved result instead of dispatching another provider call.

## safety model

the safety model is simple and deliberately narrow:

- only an explicitly configured loopback opencode server is allowed
- only repositories below configured, canonical root paths are allowed
- only configured provider/model IDs are allowed
- each worker gets a detached worktree, never the caller's checkout
- the job ledger makes delegate, follow-up, and cancel replays safe
- patch return requires a second opt-in and is bounded to the recorded base revision
- `disable` blocks future delegate calls without touching the provider

the worktree protects the caller's checkout from accidental cross-contamination. it is not an operating-system sandbox. a worker can still read files made available in that worktree and its configured provider can receive what opencode reads. do not delegate a repository whose contents you would not send to that provider.

to stop new delegation right now:

```json
{ "action": "disable", "requestId": "stop-opencode-workers-01" }
```

this does not abort a job already running. use `cancel` for that job. re-enabling needs `enableBridge: true` consent. the `enabled: false` setting in the local config file is the persistent kill switch.

## development

```sh
npm test
npm run pack:check
```

the test suite uses a fake local opencode http server. it does not start opencode, read authentication state, call deepseek, or change repositories outside temporary test fixtures.

`DESIGN.md` records the implementation decisions and observable guarantees. this README is the operating guide; that document is the receipt for why the boundaries look like this.

## license

[mit](LICENSE). use it, change it, and ship it. just do not confuse a local worktree with a sandbox.
