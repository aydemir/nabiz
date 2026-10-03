# packages/core/

## Responsibility
`nabiz-core` paketi: saf motor (`src/`, ayrıntı `src/codemap.md`de) + derli
`dist/` (host plugin'i buradan çözer — tazelik kritik, NABIZ-013).

## Integration
- Tüketici: `../harness-opencode` (plugin + MCP), `../../extensions` (pi).
- Derleme: kökten `npm run build` (`tsc` → `dist/`).
