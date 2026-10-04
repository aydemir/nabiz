# packages/harness-opencode/plugins/

## Responsibility
Altı V2 opencode plugin'i (`export default Plugin.define(...)`) + MCP
bash-tools sunucusu. Tek giriş noktası `../plugin/index.ts` (bundle, id `nabiz`).

## Design
- `opencode-hbmon.ts` — 7 tool (`hbmon_watch/wait/status`, `bg_run/status/logs/kill`),
  terminal bildirimi **native**: `pushOnSettle` → `session.synthetic`
  (inbox + `execution.wake`); `bg-wake.mjs` yalnız kalıcılık yedeği, ikisi
  `claimWake` marker'ıyla ayrılır. `bg_logs(wait_ms)` bloklayan okuma.
  hepsi `options.namespace: "build_pulse"` (host kuralı: segment `^[A-Za-z0-9_-]{1,64}$`).
- `opencode-context-saver.ts` — `session.hook("context")` + `tool.execute.before/after`
  ile bağlam kırpması; `session.hook("prompt")` boş kanca.
- `opencode-build-tracker.ts` — `execute.before/after` ile build izleme.
- `opencode-truncation-noticer.ts`, `opencode-settle-noticer.ts` — kesilme
  bildirimi + next-contact yerleşimi.
- `opencode-cpu-liveness.ts` — CPU stall gözcüsü (yalnız `session.hook("context")`).
- `server.ts` — re-export barrel (plugin değil).
- `lib/opencode-compat.ts` — host varsayım tamponu (ad/namespace
  regexleri, hook adları, izin sözlüğü; `adaptToolInfo` kayıt anında
  fail-loud doğrular; slim v1/v2 katmanından ilham).
- `mcp-bash-tools/` — ayrı MCP sunucusu: `server.ts` (ad `nabiz`) + `src/tools/`
  (`safe`/`raw` → LLM'de `nabiz_safe`/`nabiz_raw`); `src/exec.ts` çalıştırma çekirdeği.

## Flow
1. Host dizini yükler → `plugin/index.ts` altı setup'ı alfabetik sırayla koşturur.
2. Tool çağrısı → core motoru → `{ content }` sonucu.
3. MCP yolu bağımsızdır: `dist/plugins/mcp-bash-tools/src/server.js` ayrı süreç.

## Integration
- Tüketir: `nabiz-core/*` (**dist** üzerinden — bayat dist tüm bundle'ı
  düşürür; bekçi `scripts/check-dist.mjs`, NABIZ-013).
- Yükleyen: config `plugins` girdisi → `plugin/index.ts`.
