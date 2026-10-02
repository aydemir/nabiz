---
id: NABIZ-014
title: "canlı config'deki yabancı plugin girdilerinin yük durumu"
status: done
priority: P2
created: 2026-10-02
updated: 2026-10-02
labels: [config, plugin, opencode-compat]
depends_on: []
---

# NABIZ-014 — yabancı plugin girdileri ve nabız girdilerinin durumu

## Amaç

Canlı config'deki nabız dışı plugin girdilerinden yüklenemeyenler vardı:
log'da tekrarlayan `failed to load plugin` (her yüklemede yeniden).
Nabız'ın kendi `plugin` + `plugins` girdileri baştan beri sağlamdı;
sorun nabız kodu değil, yabancı girdilerdi. Aynı sınıf (sessizce
çalışmayan config girdisi) diye kayda alındı.

## Nabız için çıkarılan ders (loader sözleşmesi)

Host, plugin `default` export'unda `{id + effect|setup}` arıyor. Bu
şekle uymayan girdi WARN veriyor — ama WARN, tool yokluğu demek değil:
şekil dışı kalan girdinin tool'ları yine de kaydolup çalışabiliyor
(canlı kanıt: katalogdan düşme/geri-dönme + tool çağrısı `success`).
Yani "failed to load" satırı tek başına hüküm vermez; **etki ölçülür**
(katalogda görünüyor mu, çağrı çalışıyor mu).

Nabız tarafı bu sözleşmeye uyuyor: `plugin/index.ts`
`Plugin.define({id, setup})` kullanıyor; bundle yükleniyor, 7 tool
kayıtlı, `setup.mjs --check` temiz.

## Kapsam (nabız tarafı)

- Yapılan: yüklenemeyen yabancı girdi config'den çıkarıldı (çalışan
  yabancı girdiye dokunulmadı); nabız girdileri değişmedi.
- Yapılmayan: nabız'ın kurulum mantığı değişmedi (`setup.mjs` yalnız
  **kendi** girdilerine dokunur; yabancı `plugin` dizisine bilerek
  dokunmaz — AGENTS.md ve setup.test.mjs'deki kural).
- Canlı config yedeği alındı (işlem öncesi).

## Doğrulama

- Nabız bundle'ı yükleniyor, 7 tool katalogda, `memory` dahil yabancı
  çalışan tool'lar yerinde.
- `setup.mjs --check` temiz (nabız girdisi değişmedi).
