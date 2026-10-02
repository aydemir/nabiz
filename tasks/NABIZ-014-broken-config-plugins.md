---
id: NABIZ-014
title: "config'deki opencode-mem + opencode-agent-browser plugin'leri yüklenemiyor"
status: todo
priority: P2
created: 2026-10-02
updated: 2026-10-02
labels: [config, plugin, opencode-compat]
depends_on: []
---

# NABIZ-014 — config'deki iki plugin ölü (V1UAE biçim)

## Amaç

`~/.config/opencode/opencode.jsonc` → `plugin: ["opencode-mem",
"opencode-agent-browser", …]` iki plugin de **yüklenemiyor**:

```
message="failed to load plugin" target=opencode-mem
  cause="PluginModule.LoadError: Plugin must export a default definition
         with an id and an effect or setup function.
         (cause: SchemaError(Missing …))"
```

Log'da **133'er kez** (her plugin yüklemesinde tekrarlanıyor — bugün).
`opencode-agent-browser` aynı hatayı veriyor. Yani kullanıcı iki plugin'i
aktif sandığı halde hiçbiri yüklenmiyor; etkileri (memory, browser) yok.

Nabız kapsamı dışı ama aynı sınıf: **config'te duran bir şey çalışmıyor ve
sessizce**. Nabız'ın kendi `plugin` + `plugins` girdileri sağlam.

## Doğrulama (2026-10-02)

- Log'da 133 × `opencode-mem`, 133 × `opencode-agent-browser` aynı hatayla.
- `@opencode-ai/plugin` sürümü `~/.config/opencode/package.json`'da
  **1.17.3** — V1 major. opencode 2.0.21 V2 plugin API'sini bekliyor.
  Bu, V1UAE (V1 uyumluk kabuğu) yazımının V2'de tanınmadığı anlamına
  geliyor → iki plugin'in de **güncellenmesi** gerekiyor.

## Kapsam

- Yapılacaklar
  - Her iki plugin'in V2 uyumlu sürümünü bul/upgrade et (`opencode plugin
    update opencode-mem` dene; yoksa paketi kaldırıp V2 sürümü ekle).
  - `~/.config/opencode/package.json`'daki `@opencode-ai/plugin: 1.17.3`
    pin'ini V2 ile hizala — bu, V1UAE kabuğunun neden tanınmadığının
    muhtemel kökü.
  - Karar: ya ikisi V2'ye taşınır ya da config'den **kaldırılır**
    (ölü girdi, düz config tercih edilebilir — ama kullanıcı kararı).
- Yapılmayacaklar
  - Nabız'ın kendi kurulum mantığı (`setup.mjs` yalnız **kendi**
    girdilerine dokunur; yabancı `plugin` dizisine bilerek dokunmaz —
    AGENTS.md ve setup.test.mjs'deki "yabancı girdiye dokunma" kuralı).

## Etkilenen Dosyalar

- `~/.config/opencode/opencode.jsonc` (kullanıcı config'i — repo değil)
- `~/.config/opencode/package.json`

## Doğrulama

- `failed to load plugin` log'da **0** (nabız + diğerleri).
- Ya iki plugin gerçekten yükleniyor (etkileri görünür), ya config'de yok.
- `setup.mjs --check` hâlâ temiz (nabız girdisi değişmedi).
