# nabiz-opencode

nabiz adapter for OpenCode 2.x (`@opencode/plugin`): six plugins
(`Plugin.define({ id, setup })`), plus MCP bash-tools, scripts, and tests.
Imports the shared engine (`nabiz-core`) — no copied motor code.

Part of [`aydemir/nabiz`](https://github.com/aydemir/nabiz).

## Plugins (V2 discovery)

`opencode-context-saver`, `opencode-build-tracker`,
`opencode-truncation-noticer`, `opencode-cpu-liveness`,
`opencode-settle-noticer`, `opencode-hbmon` — plus MCP server
`mcp-bash-tools` (`nabiz_safe` / `nabiz_raw`).

V2 gerçeği: `plugins` config girdisi DOSYA kabul etmez
("configured plugin path must be a directory"); bir dizinden SADECE
`index.ts` yüklenir. Bu yüzden `plugin/` TEK ENTRYPOINT'tir
(`index.ts` altıyı birden `nabiz` id'siyle kaydolur, hook sırası
alfabetik dosya sırasıyla aynı). `setup.mjs --yes` config'e paket
dizinini yazar, repo'ya ait stale dosya girdilerini temizler, eski
symlink-modundan kalan nabiz symlink'lerini kaldırır (çift kayıt
önlenir) ve `mcp.nabiz` yolunu bu repo dist'ine çevirir.

## Options (V2 `{package, options}`)

```jsonc
{
  "plugins": [
    {
      "package": "/root/nabiz/packages/harness-opencode/plugin",
      "options": {
        "thresholdMs": 60000,
        "opencode-truncation-noticer": { "enabled": false }
      }
    }
  ]
}
```

Tek çanta paylaşılır (her plugin kendi anahtarını okur); `<plugin-id>`
alt-çantası üstüne yazar. `enabled: false` (kök) tüm paketi kapatır
(tek kill-switch). Resmi şemada `pluginOptions` anahtarı YOKTUR (V1
artığı) — seçenekler buradan verilir.

## ToolContext / namespace (Faz 8)

Yedi tool da promise yüzeyinde `ToolContext`
(`sessionID`/`agent`/`messageID`/`id`/`signal`/`progress`) alır
(kilit: `tests/tool-context.test.mjs`):
`signal` → `hbmon_wait`/`hbmon_status` iptali (throw yok, iptal özeti döner);
`progress` → `hbmon_wait` ara-durum bildirimi (NABIZ-005 kaynağıyla aynı).
Hepsinde `options: { namespace: "build_pulse" }` — host kuralı **segment
bazlı**: `ns.split(".").every(seg => /^[A-Za-z0-9_-]{1,64}$/)` (nokta
ayırıcı, boşluk/Unicode reddedilir). Reddedilen tool `tools/list`'te
**görünmez**, yalnız log'da `Skipping invalid tool registration` çıkar —
kilit `tests/plugin-bundle.test.mjs`.
(`^[A-Za-z0-9_-]{1,128}$` kuralı namespace'e değil, fully qualified **tool
adına** aittir; ikisi karıştırılırsa uzun segment sessizce kırılır.)

## Tek wakeup yolu (Faz 9)

`notify:true` ile kaydedilmiş bir bg görevine ait build adı settle edince
`[sn]` notu üretilmez ve oturum-açılış disclosure'ındaki `Pending settles`
listesine de girmez — bildirim `bg-wake` bekçisinden gelir (tek kaynak,
çift bildirim yok). Eşleşme `nabiz-core/bg-tasks` (`bgDir`/`listRecords`)
üzerinden yapılır; bg kaydı yoksa/sessizse settle-noticer kendi bildirimini
yapar.

## Foreground / spinner (NABIZ-004)

Opencode TUI `running` durumundaki her tool çağrısına otomatik
`work_spinner` çizer (sunucu SSE → istemci kozmetiği; TUI kodu bizde
değil, değiştirilmez). Kural: **spinner istiyorsan foreground çağır.**

Foreground kalanlar (kısa + bloklayan):

- `nabiz_safe` / `nabiz_raw` (MCP): `timeout_ms` default 30000.
- `hbmon_wait`: daemon tavanı default 50s (`defaultTimeoutSec`),
  gateway ~60s altı tutulur; `timeout (hâlâ çalışıyor)` dönerse aynı
  sock ile tekrar çağır (kesinti değil, devam protokolü).
- `hbmon_watch` / `hbmon_status`, `bg_status` / `bg_logs` / `bg_kill`:
  hızlı handshake/sorgu, foreground kalır.
- Uzun işler için `bg_run` (hemen döner) + `bg-wake.mjs` bekçisi; ara
  durum için `bg_status` build-mon izlemesine düşer (`events.jsonl`
  reuse, NABIZ-005), final `[sn] settled` ile gelir.

Timeout/heartbeat politikası (kanıt: kod):

- `nabiz_safe`/`raw` → `runBash` (`plugins/mcp-bash-tools/src/exec.ts`):
  `exec` timeoutunda `exitCode: 1` + `stdout`/`stderr` korunur,
  `durationMs` döner — tool `error` fırlatmaz, TUI takılmaz.
- `hbmon_*` → `runHbmon` (`packages/core/src/hbmon-tools.ts`,
  `execTimeoutMs` default 70000): spawn timeoutunda
  `error: "hbmon çağrısı zaman aşımı (…ms)"` ile çözülür; `ENOENT`
  ise kurulum ipucu (`cargo install hbmon`, exit 127) döner.
- Canlı TUI kontrolü (10s foreground çağrıda spinner → `✓`) bu repo
  dışında yapılır (headless kanıt yok); eşik aşımında davranış yukarıdaki
  gibidir.

## Build / test

```bash
npm run build --workspace nabiz-opencode   # tsc → dist/
npm test --workspace nabiz-opencode        # node --test suite
node packages/harness-opencode/scripts/setup.mjs --check
```

`packages/core/src` değiştiyse **önce `npm run build`**: V2 plugin `.ts`
kaynaktan yüklenir ama `nabiz-core` import'ları `dist/`'ten çözülür; bayat
dist tüm plugin'i düşürür (NABIZ-013). Bekçi:
`node packages/harness-opencode/scripts/check-dist.mjs` (bayatsa exit 1;
`setup.mjs --check/--yes` de aynı kapıdan geçmez).

Windows notu: `npm install` workspace linklerini symlink ile kurar
(`node_modules/nabiz-core` → `packages/core`). EPERM/symlink hatası
alırsan terminali yönetici olarak çalıştır ya da Geliştirici Modu'nu aç
(Ayarlar → Gizlilik ve Güvenlik → Geliştiriciler için). Not: npm'in
`--install-links=false` bayrağı workspaces'e etki etmez (npm docs) —
workspace linkleri her zaman symlink'tir, bu yüzden yetki şart.
Ön-kontrol: `node scripts/check-symlink.mjs` (kurulumdan önce çalıştır;
symlink kuramıyorsa EPERM'i anlaşılır mesajla yakalar).

## Layout

- `plugins/` — the six V2 plugins (`export default Plugin.define(...)`;
  each file also loads standalone via discovery) + `server.ts` re-export barrel
  (not a plugin itself) and `mcp-bash-tools/`
- `plugin/` — the installable V2 package (single entrypoint `index.ts`,
  id `nabiz`; config `plugins` entry points here)
- `scripts/` — `setup.mjs`, `check-dist.mjs`, `build-mon.mjs`, `hbmon-build-mon.mjs`,
  `bg-wake.mjs`, `cpu-liveness-probe/`, `timeout-kill-probe/`
- `tests/` — `node --test` suite (mirrors the opencode-plugins history,
  now running against `nabiz-core`)
