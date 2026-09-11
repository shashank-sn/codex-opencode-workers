# Packaging

This repository is a private, local Codex plugin distribution. It is not configured for npm publishing.

## Verify

```sh
npm test
npm run pack:check
```

The test suite uses a fake local OpenCode HTTP server. It does not read credentials or contact a model provider.

## Create an archive

```sh
npm run pack
```

The resulting `.tgz` is written to `dist/`. It contains the plugin manifest, MCP configuration, runtime source, skill, documentation, and non-secret configuration template. It excludes tests, audit receipts, local configuration, and build artifacts.

## Local installation boundary

Extract the archive into a trusted local plugin source directory, then add that directory to a local Codex marketplace before installing it. The plugin never contains or accepts OpenCode credentials; configure OpenCode separately and create the non-secret bridge policy from `config.example.json`.

For the normal personal marketplace layout, the extracted plugin source belongs at `~/plugins/codex-opencode-workers/`, with a matching `~/.agents/plugins/marketplace.json` entry. Reinstall with:

```sh
codex plugin add codex-opencode-workers@personal
```

Start a new Codex task after reinstalling so its MCP tool and skill definitions reload.
