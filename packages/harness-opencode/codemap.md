# packages/harness-opencode/

## Responsibility
`nabiz-opencode` paketi: opencode adaptörü — 6 plugin + MCP bash-tools
+ kurulum/test altyapısı (ayrıntı alt `codemap.md`'lerde).

## Design
- `plugins/` — V2 plugin kaynakları (yerinde `.ts` yüklenir).
- `plugin/` — tek-entrypoint kurulum paketi (id `nabiz`).
- `scripts/` — `setup.mjs` + bekçiler; `tests/` — `node --test` suite.

## Integration
- Motor: `nabiz-core` (`../core`, dist üzerinden).
- Canlı config girdileri `scripts/setup.mjs` ile yazılır.
