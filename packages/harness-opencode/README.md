# nabiz-opencode

nabiz adapter for OpenCode: six plugins behind a single server entry,
plus MCP bash-tools, scripts, and tests. Imports the shared engine
(`nabiz-core`) — no copied motor code.

Part of [`aydemir/nabiz`](https://github.com/aydemir/nabiz).

## Plugins (via `./server`)

`opencode-context-saver`, `opencode-build-tracker`,
`opencode-truncation-noticer`, `opencode-cpu-liveness`,
`opencode-settle-noticer`, `opencode-hbmon` — plus MCP server
`mcp-bash-tools` (`bash_safe` / `bash_raw`).

## Build / test

```bash
npm run build --workspace nabiz-opencode   # tsc → dist/
npm test --workspace nabiz-opencode        # node --test suite
node packages/harness-opencode/scripts/setup.mjs --check
```

## Layout

- `plugins/` — the six plugins + `server.ts` barrel (function-only exports,
  `getLegacyPlugins` rule) and `mcp-bash-tools/`
- `scripts/` — `setup.mjs`, `build-mon.mjs`, `hbmon-build-mon.mjs`,
  `bg-wake.mjs`, `cpu-liveness-probe/`, `timeout-kill-probe/`
- `tests/` — `node --test` suite (mirrors the opencode-plugins history,
  now running against `nabiz-core`)
