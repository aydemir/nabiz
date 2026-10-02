---
id: NABIZ-011
title: "hbmon 7 tool namespace'i geçersiz — opencode kayıtları sessizce düşürüyor"
status: done
priority: P1
created: 2026-10-02
updated: 2026-10-02
labels: [hbmon, plugin, opencode-compat, context-economy]
depends_on: []
---

# NABIZ-011 — `namespace: "build pulse"` 7 tool'u sessizce öldürüyor

## Amaç

`plugins/opencode-hbmon.ts` yedi tool'u `options: { namespace: "build
pulse" }` ile kaydediyor. opencode 2.0.21 bu değeri **reddediyor** ve tool'u
modele hiç sunmuyor — `tools/list` üzerinde iz yok, yalnız sunucu log'unda
`Skipping invalid tool registration` satırı var.

Nabız'ın temel vaadi (`hbmon_watch → hbmon_wait → hbmon_status`,
`bg_run → bg_status/bg_logs/bg_kill`) **kurulu olmasına rağmen kullanılamaz
durumda**. MCP tarafı (`nabiz_safe`/`nabiz_raw`) namespace kullanmadığı için
ayakta kalıyor; yani "kuruldu" sanılan yüzeyin 7 tool'u ölü.

## Kanıt (canlı, 2026-10-02, opencode 2.0.21)

1. Sunucu log'u (`~/.local/share/opencode/log/opencode.log`), her plugin
   yüklemesinde 7 kez:
   ```
   level=ERROR message="Skipping invalid tool registration" name=hbmon_watch
     namespace="build pulse" error="Invalid tool namespace: \"build pulse\""
   ```
   Aynı satır `hbmon_wait`, `hbmon_status`, `bg_run`, `bg_status`,
   `bg_logs`, `bg_kill` için de.
2. Doğrulama kuralı opencode binary'sinin içinde (string tablosu):
   ```
   ^[A-Za-z0-9_-]{1,128}$  →  "Invalid tool namespace: "
   ```
   Boşluk izinli değil. (Aynı yerde `Invalid tool name:` ve rezerve `execute`
   kuralı da var — tool **adları** ayrı konu, isimlerimiz uygun.)
3. Oturumun kendi tool listesi: `hbmon_*` / `bg_*` **yok**.
4. `@opencode/plugin` 2.0.16 tip imzası (`dist/promise/tool.d.ts:23`)
   `namespace(namespace: Tool.Namespace)` — biçim doğrulaması **host'ta**,
   plugin SDK'sında değil; bu yüzden `tsc` sessiz geçiyor.

## Kapsam

- Yapılacaklar
  - Yedi `options: { namespace: ... }` satırını regex'e uyan değere çevir
    (`opencode-hbmon.ts:184,217,243,266,340,381,402`).
  - **Sessiz kayıt düşürmeyi kalıcı kilitle:** namespace geçersizse tool
    düşüyor ve ajan farkında bile değil. Repo içinde bunu yakalayan bir
    test yaz — saf string kontrolü değil, **kuralın kendisi**: kullanılan
    namespace'ler `^[A-Za-z0-9_-]{1,128}$` ile eşleşmeli (kaynak dosyadan
    okunur, `dist/`'e bakılmaz; build sırası yüzünden `dist` henüz eski
    olabilir).
  - README/disclosure metinlerinde geçen grup adını yeni değerle
    tutarlı hale getir (`packages/harness-opencode/README.md` "Hepsi
    `options: { namespace: "build pulse" }`").
- Yapılmayacaklar
  - Tool **adları** (`hbmon_watch`, `bg_run`, …) — LLM/test uyumu ve
    `tool-context.test.mjs` sözleşmesi bunlara bağlı.
  - `hbmon_*` / `bg_*` semantiği, `defaultTimeoutSec`, options şeması.
  - NABIZ-008'in yapısal kill-switch'i — namespace geçersizken de
    `enabled:false` doğru çalışıyor, sadece görünmez.

## Uygulama Planı

1. Değeri `build_pulse` yap (tek kelime, anlamı aynı, regex uyumlu).
2. Kaynak-tarama kilidi: `tests/` altında namespace kuralını test et.
3. Build + tam süit; log'da `Skipping invalid tool registration` sayısı 0.

## Etkilenen Dosyalar

- `packages/harness-opencode/plugins/opencode-hbmon.ts`
- `packages/harness-opencode/tests/` (yeni kilit)
- `packages/harness-opencode/README.md`

## Doğrulama

- Sunucu log'unda `Skipping invalid tool registration` **0**.
- Oturumda 7 tool görünür: `hbmon_watch`, `hbmon_wait`, `hbmon_status`,
  `bg_run`, `bg_status`, `bg_logs`, `bg_kill`.
- `hbmon_watch` gerçek komutta handshake döner (canlı: `hbmon --version`
  sonrası `node -e`).
- Tam süit yeşil; mevcut `options`/tool-context testleri bit-bazında aynı.

## Sonuç (2026-10-02)

- Değer `build_pulse` yapıldı (7 satır). Tool **adları** değişmedi.
- Kilit: `tests/plugin-bundle.test.mjs` → *"bundle: namespace host kuralına
  uyar"* — kaydedilen `options.namespace` değerini regex'e karşı sınar;
  namespace kullanmayan tool yoksa test boşa düşmez (kilit boşa düşmez
  kuralı).
- Canlı kanıt:
  - Servis restart sonrası oturumda `build_pulse` · **7 tool** görünür
    (`hbmon_watch` dahil — önce hiç yoktu).
  - Log'da bizim eşleşen **yeni** `Skipping invalid tool registration`
    satırı **0** (son gerçek kayıt 07:28:57, `namespace="build pulse"`,
    düzeltmeden önce).
  - Uçtan uca: `hbmon_watch` → handshake (`uuid=8765a644…`,
    `sock=\\.\pipe\hbmon-…`, `log=%TEMP%\hbmon-….jsonl`);
    `hbmon_status` → canlı daemon yanıtı `state=running`;
    build 12.3sn'de `exit 0` ile kapandı. `bg_status` bilinmeyen id'de
    dürüst hata veriyor.
- Tam süit: **245 pass / 0 fail** (5 skip: 4 LIVE + 1 symlink EPERM),
  öncesi 242 → 3 yeni kilit.

### Öğrenilen (bu depoya taşınabilir kural)

**Tip güvenliği bu sınıf hatada kanıt değil.** `@opencode/plugin`
namespace'i yalnız *tip* olarak taşıyor (`Tool.Namespace`), doğrulama
host'ta. Bu yüzden `tsc` temiz, `oxlint` temiz, testler yeşil — tool
yine de hiç kayıt olmuyordu. Aynı desen config şeklinde de var (V1 girdi
migration ile yutuluyor). Bu iki bulgu tek cümleyle: **opencode-compat
sınıfı, tip değil çalışma log'uyla kanıtlanır.**
