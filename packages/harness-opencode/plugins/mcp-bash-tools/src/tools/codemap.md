# packages/harness-opencode/plugins/mcp-bash-tools/src/tools/

## Responsibility
MCP üzerinden sunulan iki bash aracının tanımı.

## Design
- `bash_safe.ts` — budamalı çıktı (varsayılan yol).
- `bash_raw.ts` — tam çıktı (budamasız gerektiğinde).

## Flow
Çağrı → `exec.ts` → sonuç `{ content }`.

## Integration
- Kayıt: `../server.ts` (`name: "safe"` / `"raw"`).
