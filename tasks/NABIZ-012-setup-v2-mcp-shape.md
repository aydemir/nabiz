---
id: NABIZ-012
title: "setup.mjs V1 MCP şekli yazıyor (mcp.<name> + enabled) — V2 mcp.servers + disabled"
status: done
priority: P2
created: 2026-10-02
updated: 2026-10-02
labels: [setup, config, opencode-compat]
depends_on: []
---

# NABIZ-012 — setup.mjs V2-native MCP girdisi yazsın

## Amaç

`scripts/setup.mjs` canlı opencode config'ine `mcp.<name>` (V1 düz şekil)
ve `enabled: true` yazıyor. opencode 2.x düz şekli **okumuyor**; V1→V2
migration katmanı sayesinde çalışıyor, ama:

- Yazdığımız config dokümana aykırı ve V2-native değil; migration kalkarsa
  (V1 uyumluluğu geçici bir katmandır) kurulum sessizce bozulur.
- `enabled` V2'de **yok**; doğru anahtar `disabled`. Yani setup'ın
  "kullanıcının tercihini koru" mantığı yanlış alanı okuyup yanlış alana
  yazıyor.

## Kanıt (canlı, 2026-10-02, opencode 2.0.21)

1. Sunucu config'i **yalnız** iç içe formu okuyor (binary içi kaynak):
   ```js
   for (let [v, k] of Object.entries(g.info.mcp?.servers ?? {})) d.set(v, k)
   ```
   Düz `mcp.<name>` için hiçbir yol yok → ancak V1 migration'ı açık.
2. V2 şeması `Mcp.LocalConfig` (Effect şeması, binary içi):
   ```js
   { type, command, cwd, environment, disabled, codemode, timeout, protocol }
   ```
   `enabled` **yok**, `disabled` var.
3. TUI bile doğru yolu söylüyor: `Configuration: mcp.servers.<name>`.

## Kapsam

- Yapılacaklar
  - **Hedef** (yazma): `mcp.servers.nabiz` + `disabled` (kapalıysa
    `disabled: true`; açıksa alanı hiç yazmama tercih edilir — `disabled`
    yalnız kapatmak için).
  - **Okuma** (migration dayanıklılığı): `mcp.servers.nabiz` **ve** eski
    `mcp.nabiz` ikisini de tanı; `enabled:false` ve `disabled:true`
    tercihlerini ikisinden de oku. Kullanıcının V1 girdisi varken setup
    onu V2'ye **taşımak** zorunda değil — dokunmadan bırakıp `mcp.nabiz`
    hedefi de yazmak çift kayıt riski doğurur; bu yüzden taşıma kararı
    açıkça kurallı olacak.
  - Aynı `bash → nabiz` key-rename migrasyonunu iki şekilde de kabul et.
  - Mevcut kilit testleri (`tests/setup.test.mjs`) yeni hedef şekle
    güncellensin; **ayrıca** V1 girdili bir config'in de temiz kaldığı
    (`--check` kirli çıkmamalı) kilitlensin.
- Yapılmayacaklar
  - **Kullanıcının başka sunucularına dokunulmaması** — `context7`,
    `codegraph`, `chrome-devtools` girdileri `mcp.<name>` düz şekilde
    kalmaya devam edecek. Onları da taşımak kapsam dışı (migration onları
    zaten çalıştırıyor, ayrıca risksiz bir alışkanlık değişikliği değil).
  - `plugins` (paket dizini) ve `pluginOptions` muameleleri.

## Uygulama Planı

1. `desiredMcpEntry` → `{ type, command }` (+ gerekiyorsa `disabled`).
2. Okuma yardımcısı: `readMcpEntry(config)` → iç içe ya da düz, `nabiz`
   için; `bash` key'i için aynısı.
3. `computePlan` yalnız **iç içe** hedefi yazar.
4. `tests/setup.test.mjs`: mevcut beklentiler iç içe şekle döner +
   V1-girdili-konfig-kalıcı testi eklenir.
5. `--dry-run`/`--check` canlı config'te temiz çıkmalı.

## Etkilenen Dosyalar

- `packages/harness-opencode/scripts/setup.mjs`
- `packages/harness-opencode/tests/setup.test.mjs`
- `packages/harness-opencode/README.md` (kurulum notu)

## Doğrulama

- Boş config → `mcp.servers.nabiz` **yazılır**, düz `mcp.nabiz` **yazılmaz**.
- `mcp.bash` (bizim dist'i gösteren) → `mcp.servers.nabiz`'e taşınır;
  `disabled:true`/`enabled:false` tercihi korunur.
- Yabancı `mcp.bash` ve `mcp.codegraph` girdileri bit-bazında aynı kalır.
- **V1 düz şekilli canlı config'te `--check` temiz** (idempotans: script
  iç içe girdiyi görür, düz eski girdi dokunulmadan bırakılır).
- Tam süit yeşil.

## Sonuç (2026-10-02)

- `desiredMcpEntry` artık `{ type, command }` — `enabled` yazılmıyor.
  Açık sunucuda `disabled` de yazılmıyor (fail-open; kapatmak için gereken
  tek alan).
- `readMcpEntry(config, key)` → `{ found, entry, shape }`; **V2 iç içe
  öncelikli**, yoksa V1 düz. `isMcpDisabled(entry)` `disabled:true` ve
  V1 `enabled:false` ikisini de kapatma sayar.
- `computePlan` yalnız iç içe hedefe yazar; V1 düz `mcp.nabiz` **silinip**
  iç içeye taşınır (çift kayıt yok). `mcp.bash` → `mcp.servers.nabiz`
  rename'i iki şekli de kabul eder; yabancı `bash` dokunulmaz.
- Kilitler (`tests/setup.test.mjs`): V2 hedef şekli, `enabled` yok,
  düz giriş yok; V1→V2 **idempotans** (ikinci pass temiz);
  `readMcpEntry`/`isMcpDisabled` birim matrisi. Mevcut yabancı-girdi
  koruma testleri iç içe şekle döndürüldü.
- Canlı: `setup.mjs --yes` → canlı config'te `mcp.servers.nabiz`
  oluştu, düz `mcp.nabiz` **silindi**, `context7`/`codegraph`/
  `chrome-devtools` bit-bazında dokunulmadı (yedek:
  `opencode.jsonc.bak.20261002T103221`). İkinci `--check` **temiz**.
- `opencode mcp list` → nabiz connected ✓

### Kapsam dışı bırakılan (bilinçli)

Kullanıcının **kendi** düz girdileri (`mcp.context7`, `mcp.codegraph`,
`mcp.chrome-devtools`, eski `plugin` dizisi) taşınmadı — sunucu migration
katmanı onları okuyor, taşımak kapsam genişletmesi olurdu. Nabız yalnız
**kendi** girdisini normalize eder.
