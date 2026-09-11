# codex opencode workers

run a bounded opencode job from codex without pretending it is a codex subagent.

`opencode_job` is a local mcp bridge. it makes a detached worktree for one allowed repository, sends a prompt to your already-running opencode server, and saves a small job receipt locally. you can later inspect the job, wait for it, collect a bounded summary or patch, send a follow-up, or cancel it.

this exists because codex and opencode have separate runtimes. codex keeps its own model selection. the bridge sends a specific job to the provider and model configured in opencode. opencode keeps its own credentials and sessions.

## what runs where

1. codex calls `opencode_job` over mcp.
2. the bridge checks the server address, model, repository root, and consent before it creates a worktree.
3. it creates a detached worktree below its state directory and opens an opencode session in that worktree.
4. opencode performs the job with its configured provider.
5. the bridge records the session, state, content hashes, and an optional bounded result in sqlite.

the bridge does not start, restart, or kill opencode. start and own that process yourself.

## before you install it

you need node.js 24+, git, codex with local-plugin support, and a working local opencode setup. the default model IDs in `config.example.json` are opencode go deepseek defaults. they are not credentials and they do not make a provider available by magic.

start opencode on loopback:

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

the bridge accepts only `http` loopback addresses: `127.0.0.1`, `localhost`, or `::1`.

## install

clone the repository into the source directory used by your personal codex marketplace:

```sh
git clone https://github.com/shashank-sn/codex-opencode-workers.git ~/plugins/codex-opencode-workers
cd ~/plugins/codex-opencode-workers
```

create `~/.agents/plugins/marketplace.json` if you do not already have one. if you do, add only the object inside `plugins` below:

```json
{
  "name": "personal",
  "interface": {
    "displayName": "Personal"
  },
  "plugins": [
    {
      "name": "codex-opencode-workers",
      "source": {
        "source": "local",
        "path": "./plugins/codex-opencode-workers"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

the default personal marketplace resolves `./plugins/...` from your home directory. install the plugin, then start a new codex task so its mcp server and skill definitions load:

```sh
codex plugin add codex-opencode-workers@personal
```

## configure the bridge

the bridge reads non-secret policy from `~/.codex/opencode-workers/config.json` by default.

```sh
mkdir -p ~/.codex/opencode-workers
cp config.example.json ~/.codex/opencode-workers/config.json
```

set an absolute repository root you are willing to send to the configured provider. keep the URL on loopback.

```json
{
  "baseUrl": "http://127.0.0.1:4096",
  "enabled": true,
  "allowedRoots": ["/Users/you/src/repository-you-trust"],
  "models": ["opencode-go/deepseek-v4-flash"],
  "defaultModel": "opencode-go/deepseek-v4-flash"
}
```

the plugin never reads `auth.json`, accepts API keys, or forwards your environment secrets. opencode owns provider authentication.

set `OPENCODE_WORKERS_CONFIG` when you want the policy somewhere else. `OPENCODE_WORKERS_URL`, `OPENCODE_WORKERS_ALLOWED_ROOTS`, `OPENCODE_WORKERS_STATE_DIR`, `OPENCODE_WORKERS_MODELS`, and `OPENCODE_WORKERS_DEFAULT_MODEL` override the corresponding settings.

## run a job

use a fresh `requestId` for every state-changing call. delegate calls also need an explicit statement that the worker may read the worktree and send relevant files to its configured provider.

```json
{
  "action": "delegate",
  "requestId": "docs-audit-2026-09-11-01",
  "repository": "/Users/you/src/repository-you-trust",
  "task": "inspect the README for setup mistakes. do not edit files. return concrete findings.",
  "consent": { "sendWorkspaceToProvider": true }
}
```

the response gives you a job id. use it to wait for the worker:

```json
{ "action": "await", "jobId": "ocj_...", "waitMs": 25000 }
```

ask for a summary, or opt in again before returning a patch to codex:

```json
{
  "action": "result",
  "jobId": "ocj_...",
  "include": { "summary": true, "patch": true },
  "consent": { "returnPatchToCodex": true }
}
```

the remaining actions are direct:

- `status` reconciles a recorded job with opencode.
- `await` polls for at most 25 seconds.
- `followup` sends a message only to the recorded idle session. it cannot change the job's model or repository.
- `cancel` aborts that recorded session. replaying the same request is safe.
- `disable` blocks new delegation immediately. `enable` requires `enableBridge: true`.

## safety boundary

a detached worktree keeps a worker out of your active checkout. it does not limit filesystem access.

the configured provider can receive any file opencode reads in that worktree. only allow repositories you are comfortable sending there.

the bridge leaves raw task text, provider credentials, complete transcripts, and worker logs out of its ledger. the ledger keeps the job id, state, hashes, worktree path, session id, and an optional bounded result.

`enabled: false` in the config is the persistent kill switch. an `opencode_job` call with `action: "disable"` does the same thing. neither cancels a running job; call `cancel` for that job.

## development

```sh
npm test
npm run pack:check
```

the tests use a fake local opencode HTTP server. they do not call a provider, read credentials, or write outside temporary test repositories.

`DESIGN.md` explains the implementation choices and the evidence behind them. [MIT](LICENSE).
