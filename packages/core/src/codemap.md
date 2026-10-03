# packages/core/src/

## Responsibility
Saf motor (`nabiz-core`): opencode harici hiçbir şeye bağımlı olmayan
iş-mantığı — hbmon daemon istemcisi, bg görev kayıtları, metin
kırpma/bildirim biçimleyiciler. Plugin'ler yalnızca sarmalayıcıdır.

## Design
- `hbmon-tools.ts` — daemon handshake/watch/wait/status (`runHbmon`,
  `watchBuild`, `waitBuild`, `statusBuild`); `resolveHbmonBin` env/PATH çözer.
- `bg-tasks.ts` — bg kayıt CRUD + cursor receipt + offset/shell yardımcıları
  (`bgDir`, `resolveRecord`, `writeRecord`, `shellArgv`, `outFromSock`).
- `settle-notice.ts` — next-contact bildirim dizin çözümleme (`resolveEventDirs`).
- `progress.ts`, `prune.ts`, `raw-refill.ts` — ilerleme biçimleme, bağlam
  kırpma, ham çıktı dolgusu.
- `*-disclosure.ts`, `disclosure.ts` — tek-kez açıklama metinleri
  (kill-switch kapalıyken bile görünen iz).

## Flow
1. Plugin `setup` → core fonksiyonu çağırır (doğrudan import, efekt yok).
2. hbmon yolu: `watchBuild` sock döner → `waitBuild` bloklar → `statusBuild` yoklar.
3. bg yolu: `bg_run` kayıt yazar → bekçi script olayı yazar → `resolveRecord` okur.

## Integration
- Tüketici: `packages/harness-opencode/plugins/*`, `extensions/*` (pi portları).
- Dış bağımlılık: hbmon daemon binary (`hbmon --version` → 0.2.2), `node:fs/path`.
