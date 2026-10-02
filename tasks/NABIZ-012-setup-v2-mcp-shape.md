---
id: NABIZ-012
title: "setup.mjs V1 MCP şekli yazıyor (mcp.<name> + enabled) — V2 mcp.servers + disabled"
status: done (gerekçe düzeltildi)
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

---

## GEREKÇE DÜZELTMESİ (altajan deneyi, 2026-10-02) — ÖNEMLİ

Bu task "düz form **okunmuyor**" varsayımıyla açılmıştı. **Deney bunu
çürüttü.** Kontrollü deney (canlı config'e geçici sunucular, yedekli, sonra
geri alındı):

| Deneme | Sonuç |
|---|---|
| `mcp.probeflat` (düz V1) | **connected** |
| `mcp.probenested` (düz) | **connected** |
| `mcp.servers.probev2` (iç içe) | **connected** |
| `mcp.probeenabledfalse` (düz + `enabled:false`) | **disabled** |
| `mcp.servers.probedisabledtrue` (iç içe + `disabled:true`) | **disabled** |
| `mcp.probecontrol` (düz + `enabled:true`) | **connected** |

**Düzeltmeler:**

1. **Düz form çalışıyor.** opencode 2.0.21 `mcp.<name>` girdisini de
   kabul ediyor/bağlanıyor. "Sunucu düz formu okumaz" **yanlıştır**.
   Uyumluluk katmanının binary'deki **yerini bulamadım** (tek okuma yolu
   `Object.entries(g.info.mcp?.servers ?? {})`; düz→iç içe dönüşümünü
   içeren bir dizgi/kod bulamadım — SDK şeması da düz formu tanımıyor:
   `Config.MCP.Info = { timeout?, servers? }`). Yani: **etki kanıtlı,
   mekanizma bulunamadı.** Bu, "migration var" hipotezini doğrulamaz.
2. **`enabled` de çalışıyor.** `enabled:false` sunucuyu gerçekten
   kapatıyor. "Effect Struct decode'da sessizce atılır, `enabled:false`
   işe yaramaz" **yanlıştır** — en azından düz formda. (İç içe form +
   `enabled:false` denenmedi; V2 şemasında alan yok, yani orada muhtemelen
   yutulur. Test edilmemiş bir boşluk.)
3. Bu nedenle task'ın **gerekçesi** düzeltilmeli: yaptığımız değişiklik bir
   **hata düzeltmesi değil, kanonikleştirme**. `setup.mjs` artık dokümana
   uyan V2 şeklini (`mcp.servers.<name>` + `disabled`) yazıyor, V1'i de
   okuyup aynı hedefe normalize ediyor. Faydası: (a) doküman uyumu,
   (b) iki şekli birden taşıma ihtimali yok, (c) `enabled` gibi V2'de
   tanımsız alanlara güvenmek gerekmiyor.
4. Gerçek kırık **başka yerde**: `opencode-mem` ve `opencode-agent-browser`
   her plugin yüklemesinde **"Plugin must export a default definition with
   an id and an effect or setup function"** ile başarısız oluyor (log'da
   133'er kez). Yani bu iki plugin **çalışmıyor** — nabız kapsamı dışı ama
   config'de duruyor. NABIZ-014'e ayrıldı.

### Metodoloji notu

"Okuma yolunda düz form yok" gözlemi **yanlış negatif** verdi: gerçek okuma
yolunu bulmuşum, ama başka bir yerden normalize edilmiş veri geldiğini
düşünmemiştim. Düz-okuma yolu bulmak, formun **okunmadığı** anlamına
gelmez — **etki deneyiyle** sınanmalıydı. Aynı hata namespace'de de vardı
(`{1,128}` ≠ `{1,64}`): binary'de bir dize bulmak, o dizenin **hangi
değere uygulandığını** kanıtlamaz.
