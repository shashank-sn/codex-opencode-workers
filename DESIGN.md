# Design: Codex OpenCode Workers

## Outcome

Codex delegates a bounded task to an OpenCode session using an existing local DeepSeek configuration. The interaction is an MCP tool call, not a fake Codex child thread.

## Chosen shape

`opencode_job` is one discriminated MCP tool with `delegate`, `status`, `await`, `result`, `followup`, and `cancel` actions. It owns a SQLite job ledger, a detached git worktree per job, and an OpenCode HTTP gateway. The ledger maps one request ID to one job/session/worktree and makes replay safe after an MCP failure.

The gateway sends the canonical worktree in `directory` on every OpenCode request, including mutating requests. It accepts only locally configured loopback OpenCode URLs and an allowlisted DeepSeek model. It never reads OpenCode credentials, accepts provider keys, or returns raw transcripts/logs.

## Synthesis decision

Candidate A is the base: its single deep tool boundary and ledger-first recovery fit the documented Codex MCP and OpenCode session contracts. From Candidate B we retain an explicit future process-ownership tuple for any optional service supervisor. Version 1 deliberately does not start or kill OpenCode processes; an administrator supplies a loopback `OPENCODE_WORKERS_URL`. This removes unverified process lifecycle and sandbox claims from the trusted path.

Bridge-created detached worktrees are the only version-1 execution surface. Direct checkout writes, arbitrary directories, arbitrary providers/models, and native-child emulation are out of scope.

## Observable success

- A fake OpenCode HTTP server proves every request carries the job worktree directory.
- Duplicate request IDs never send a second prompt.
- Follow-up uses the recorded session; cancel is idempotent.
- A result contains only an explicit bounded summary and/or revision-bound patch.
- Missing consent, non-loopback endpoints, unallowlisted roots, and unallowlisted models fail before delegation.

## Unrun evidence

No real DeepSeek call, real OpenCode server restart, process sandbox, or Codex app installation is part of this build. Those require separate opt-in validation.
