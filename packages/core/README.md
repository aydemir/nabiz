# nabiz-core

Shared host-independent engine for the nabiz monorepo: hbmon client,
bg-task helpers, bounded-read cursor, and notice/disclosure texts.
Pure TypeScript — no `@opencode-ai/plugin` / pi imports allowed
(enforced by review; see `docs/migration-plan.md` Faz 1).

Part of [`aydemir/nabiz`](https://github.com/aydemir/nabiz).

## Build

```bash
npm run build --workspace nabiz-core   # tsc → dist/
```

## Exports

| Subpath | Contents |
|---|---|
| `nabiz-core/hbmon-tools` | `runHbmon`, `watchBuild`, `waitBuild`, `statusBuild`, `summarizeWait`, `resolveHbmonBin` |
| `nabiz-core/bg-tasks` | sidecar records, `readOutTail`/`readOutCursor`, `formatCursorReceipt`, `createOffsetTracker`, `readLastEvent`, `isTerminalState` |
| `nabiz-core/prune` | output pruning for model safety |
| `nabiz-core/disclosure` | shared disclosure texts |
| `nabiz-core/*-disclosure` | per-plugin disclosure texts |
| `nabiz-core/settle-notice` | finished-build notification helpers |
| `nabiz-core/truncation-notice` | read-truncation notice helpers |
| `nabiz-core/raw-refill` | raw-output refill helpers |

Consumers: `nabiz-opencode` (`packages/harness-opencode`) and the pi
extensions (`extensions/` — see `docs/port-notes.md` Faz 3 for what stayed
local and why).
