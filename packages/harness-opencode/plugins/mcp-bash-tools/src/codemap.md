# packages/harness-opencode/plugins/mcp-bash-tools/src/

## Responsibility
`nabiz` MCP sunucusunun çalıştırma çekirdeği (ayrı süreç, plugin'den bağımsız).

## Design
- `server.ts` — sunucu girişi (ad `nabiz`); tool listesi.
- `exec.ts` — komut çalıştırma çekirdeği.
- `tools/bash_safe.ts`, `tools/bash_raw.ts` — `safe` (budamalı) / `raw`
  (tam çıktı) varyantları → LLM'de `nabiz_safe`/`nabiz_raw`.

## Flow
1. Host `dist/plugins/mcp-bash-tools/src/server.js` sürecini başlatır.
2. `tools/list` → safe/raw; `tools/call` → `exec.ts` → bash/ComSpec.

## Integration
- Config: `mcp.servers.nabiz` (V2 iç-içe şekil).
- Plugin tool'larından bağımsız yükleme yolu (NABIZ-011'de ayakta kalan kısım).
