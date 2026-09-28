---
id: NABIZ-010
title: "Wake mesajı üç yerde kopyalanmış; core'daki wakeMessage üretimde ölü"
status: done
priority: P2
created: 2026-09-27
updated: 2026-09-28
labels: [bg-hbmon, hygiene, contract]
depends_on: []
---

# NABIZ-010 — Wake mesajı üçlü kopyası

## Amaç

Ajanın gördüğü tek satırlık uyanma metni **üç ayrı yerde** yazılı:

| Yer | Rol |
|---|---|
| `packages/core/src/bg-tasks.ts:194-197` `wakeMessage()` | dışa **export** edilmiş, `nabiz-core` alt yolundan yayımlanıyor — ama **yalnız test** çağırıyor |
| `packages/harness-opencode/scripts/bg-wake.mjs:166` | **üretim yolu** (b encapsulates) |
| `packages/harness-opencode/scripts/bg-wake.mjs:318` | tanı log satırı (çalıştırılacak komutun yankısı) |

Bugün üçü de aynı metni üretiyor ama `:196`'da `code === undefined ? "?" : String(code)`
ile `:166`'da `${code ?? "?"}` **farklı ifadelerle** yazılmış. Biri düzeltilir
diğeri sessizce eski kalır — ve bu metin modele giden **sözleşme** cümlesi.

Yan etki: `nabiz-core/bg-tasks` alt yolu bir dışa açıklık olarak "wake
biçimlendiricisi" sunuyor ama kimse kullanmıyor; bir sonraki okuyucu
`wakeMessage`'in gerçek metni ürettiğini varsayar.

## Kapsam

- Yapılacaklar
  - `bg-wake.mjs:166` `wakeMessage`'i `nabiz-core`'dan **import** etsin;
    metin tek kaynaktan gelsin.
  - `:318` tanı satırı da aynı kaynaktan üretilsin (veya açıkça
    "örnek/şablon" olduğu işaretlenip ayrıldırılsın).
  - Test `bg-tasks.test.mjs:172-173` **üretim yolunu** doğrulasın: mock/bağımlı
    enjeksiyonla `bg-wake.mjs`'in ürettiği metin `wakeMessage` çıktısıyla
    birebir eşleşsin. Bugünkü test yalnız core fonksiyonunu test ediyor,
    yani **kopyanın kendisini kilitlemiyor** — asıl boşluk bu.
- Yapılmayacaklar
  - `opencode run -s …` enjeksiyon mekanizmasının değişmesi.
  - `resolveWakeNodeBin` çalışma zamanı seçimi.
  - Metnin **içeriğinin** değişmesi (kullanıcıya görünür sözleşme; ayrı görev).

## Uygulama Planı

1. `bg-wake.mjs` içine `import { wakeMessage } from "nabiz-core/bg-tasks"`.
2. `:166` ve `:318` çağrıya geçsin.
3. **Kritik doğrulama adımı:** `bg-wake.mjs` **detached** bir süreçte,
   `resolveWakeNodeBin` ile bulunan node ile çalışıyor (opencode V2'de
   `process.execPath` opencode binary'si, script çalıştıramaz —
   `opencode-hbmon.ts:96-103`). ESM çözümlemesinin bu ayrı süreçte
   çalıştığını **ölçerek** doğrula; workspace paketinin göreli yolu
   bulunamazsa `createRequire`/mutlak yol gerekir.
4. Testi üretim yoluna bağla.

## Etkilenen Dosyalar

- `packages/harness-opencode/scripts/bg-wake.mjs`
- `packages/core/src/bg-tasks.ts` (`wakeMessage` dokümanı: artık
  üretim-durumu)
- `packages/harness-opencode/tests/bg-tasks.test.mjs`

## Doğrulama (2026-09-28 uygulandı)

- Canlı: sahte `opencode` (PATH) + terminal olaylı `.jsonl` ile `bg-wake.mjs`
  koştu → enjeksiyon metni `wakeMessage` çıktısıyla **birebir** aynı
  (`done`/`0` ve `failed`/kodsuz iki durum).
- Detached ESM çözümlenmesi çalışıyor: `nabiz-core/bg-tasks` import'u
  `node packages/harness-opencode/scripts/bg-wake.mjs` altında hatasız
  çözüldü (workspace symlink + `dist` üzerinden).
- `rg "bg_status/bg_logs ile detaya bak"` → tek tanım
  (`packages/core/src/bg-tasks.ts:201`) + işaretli şablon (`bg-wake.mjs:322`
  dry-run, `<state>`/`<code>` yer tutuculu, yorumla ayrıldı).
- Test: `bg-wake: üretim enjeksiyon metni wakeMessage ile birebir`
  (`packages/harness-opencode/tests/bg-tasks.test.mjs`) — kopyayı değil
  üretim yolunu kilitler. Suite: 20/20 yeşil, davranış değişmedi (saf DRY;
  `code ?? undefined` ile eski `??` semantiği korundu).

## Doğrulama (uygulama öncesi plan — üstteki gerçekleşti)

- Canlı: `bg_run` ile biten bir task → uyanma metni `wakeMessage` çıktısıyla
  **birebir** aynı.
- Detached süreçte import çözülüyor (yukarıdaki 3. adım); `bg-wake.mjs`
  elle çalıştırıldığında import hatası vermiyor.
- `rg "bg_status/bg_logs ile detaya bak"` → yalnız **bir** tanım.
- Mevcut testler yeşil; hiçbir davranış değişmiyor (saf DRY).
