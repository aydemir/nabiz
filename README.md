# nabiz

**English** | [Türkçe](README.tr.md)

Keeps the pulse of long-running work: build tracking, background tasks, notifications.
While the agent works on stage, heavy jobs run backstage — and report back when done.

## Layout

- `extensions/hbmon.ts` — long build tracking: `hbmon_watch` / `hbmon_wait` / `hbmon_status`
- `extensions/bg-hbmon.ts` — background tasks: `bg_run` / `bg_status` / `bg_logs` / `bg_kill`
  + `/bg` + `/bg-status`. Backed by the hbmon daemon; survives pi restarts.
- `.mcp.json` — MCP servers (codegraph, bash, bm), lazy-loaded.
- `docs/port-notes.md` — internal technical notes.
- `docs/migration-plan.md` — opencode-plugins → monorepo migration plan.
- `packages/core/` — shared host-independent engine (`nabiz-core`: hbmon
  client, bg-tasks, prune, notice/disclosure texts). No host imports.
- `packages/harness-opencode/` — opencode adapter (`nabiz-opencode`:
  6 plugins via single server entry + MCP bash-tools + scripts/tests).

## Usage

```bash
# quick test (loads without copying)
pi -e /root/nabiz/extensions/hbmon.ts -p "run ['sleep','5'] with hbmon_watch, wait with hbmon_wait, report in one sentence"

# permanent install (package manifest)
pi install /root/nabiz

# settings.json extensions list:
# ["/root/nabiz/extensions/hbmon.ts", "/root/nabiz/extensions/bg-hbmon.ts"]
```

## Requirements

- The `hbmon` binary (`~/.cargo/bin/hbmon` or on `PATH`). If missing, extensions
  return an install hint: `cargo install hbmon`.

## Verification

`watch → wait → status` flow on a real `cargo build`:
same handshake, same `woke_on` summaries, same exit mapping
(0 done / 1 failed / 2 dep-missing / 124 timeout / 137 oom / 3 internal).
