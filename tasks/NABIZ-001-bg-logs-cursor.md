---
id: NABIZ-001
title: "bg_logs cursor protokolü (offset/next_offset/truncated) + tekrar-okuma uyarısı"
status: done
priority: P1
created: 2026-09-23
updated: 2026-09-24
labels: [bg-hbmon, context-economy]
depends_on: []
---

# NABIZ-001 — bg_logs cursor protokolü

## Amaç

`bg_logs` bugün 50KB tail döndürüyor; model nerede kaldığını bilemez, aynı
bölgeyi tekrar tekrar okur (context israfı). Cursor protokolü ile artımlı okuma
mümkün olur, gereksiz tekrar biter.

İlham: minimax-code `task_output` — `offset` parametresi, `next_offset` +
`truncated` makbuzu, aynı offset tekrar okunursa server-side polling uyarısı
(`local-task-control.ts` pollingHint).

## Kapsam

- Yapılacaklar
  - `bg_logs`'a `offset` (bayt) parametresi; yanıta `next_offset` + `truncated`
    ekle (`<task_output_cursor ... />` benzeri makbuz).
  - Aynı `(task, offset)` üst üste okunursa tek satırlık uyarı: "yeni çıktı yok;
    `wait_ms` ile bekle ya da bildirimi bekle" (2. göz notu: prompt disiplini
    yetmez, runtime da yakalamalı).
  - 50KB cap korunur; `offset=0` replay'e izin verir.
- Yapılmayacaklar
  - Bloklayan bekleme (o NABIZ-003).
  - stdout/stderr ayrımı (hbmon `.out` birleşik; ayrı TASK adayı).

## Uygulama Planı (detay — 2026-09-23, opencode-plugins TASK-133'ten port)

0. **Kapsam kilidi:** NABIZ-002 (persist) yokken cursor state'i bellekte tutulur;
   restart'ta sıfırlanır (dokümante, engel değil). `tail` yolu bayt-birebir korunur.

1. **Okuma yardımcısı** (`extensions/bg-hbmon.ts`, `readBounded` YANINA — mevcut
   fonksiyona dokunma):
   `readOffset(outputPath, offset, maxBytes) → { text, nextOffset, size, truncated }`
   - Aralık `[offset, offset+maxBytes)`; `nextOffset = offset + okunan`.
   - `offset > size` → `{ text: "", nextOffset: size }` (cursor EOF'a sabitlenir).
   - Negatif/NaN → 0'a clamp. `maxBytes` üst sınırı `MAX_LOG_BYTES` (50KB) ile aynı.
   - UTF-8 bayt kesimi olduğu gibi bırakılır (tail ile aynı trade-off).

2. **Şema:** `BgLogsParams`'a `offset: Type.Optional(Type.Number({
   description: "Artımlı okuma bayt konumu (önceki yanıtın next_offset'i; yoksa tail modu)" }))`.

3. **Execute dalı** (`bg_logs`, ~599-629): `offset === undefined` → mevcut tail yolu
   (body + truncation notu + `snapshot(task)` eki aynen). Değilse makbuz + metin:
   ```
   [<ad> .out offset=0 next_offset=512 size=15360 TRUNCATED, devamı var]
   (devamı için offset=512 ile tekrar çağır)
   <metin>
   ```
   EOF + metinsiz → `(yeni çıktı yok)` satırı. Mevcut return zarfı
   (`textResult(display + status, { task: snapshot })`) korunur.

4. **Tekrar tespiti (DÜZELTME):** modül-seviyesi `lastOffsetByTask: Map<taskId, offset>`;
   saklanan **istenen offset**'tir — yukarıdaki 2. maddedeki "son (taskId, nextOffset)"
   ifadesi nextOffset sakla anlamına gelmez; nextOffset saklanırsa normal artımlı
   okuma (`offset == önceki nextOffset`) yanlış uyarı üretir (opencode-plugins
   TASK-133'te kanıtlandı). Eşitlikte body başına tek satır:
   `[tekrar] yeni çıktı yok; bekle ya da bildirimi bekle (offset=N)`.
   - **Metin tutarlılık notu:** Kapsam'daki uyarı taslağı "`wait_ms` ile bekle" diyor
     ama bloklayan bekleme NABIZ-003'te. Bu task'ta wait'siz metin ship edilir;
     NABIZ-003 uyarıyı `wait_ms`'li hale günceller.
   - `finishTask` içinde `lastOffsetByTask.delete(task.id)` (biten task Map'te
     yaşamaz — `tasks.delete` ile aynı yer; bellek sızıntısı yok).

5. **Description:** cursor kullanımı 2-3 cümle (`offset`/`next_offset`, tekrar
   uyarısı, `tail` ile karıştırmama).

6. **Doğrulama** (`pi -e extensions/bg-hbmon.ts` — repo'da test framework'ü yok):
   uzun komut → `bg_logs` (cursor makbuzu) → `offset=next_offset` (yalnızca yeni)
   → aynı offset tekrarı (uyarı) → offset'siz çağrı (eski tail formatı, regresyon).
   Opsiyonel: `/tmp` smoke script'i (node ile `readOffset` birim kontrolü).

## Etkilenen Dosyalar

- `extensions/bg-hbmon.ts` (`bg_logs` tool + okuma yardımcısı)
- `packages/core/src/bg-tasks.ts` (`readOutCursor` + `formatCursorReceipt` + `createOffsetTracker`)
- `packages/harness-opencode/plugins/opencode-hbmon.ts` (`bg_logs` offset dalı + `bg_kill` forget)
- `packages/harness-opencode/tests/bg-tasks.test.mjs` (cursor + tracker + makbuz + plugin testleri)

## Uygulama notu (2026-09-24, core-first sapma)

Spec pi-local helper öngörüyordu (`readOffset` yanında `readBounded`); onun
yerine mantık **core'a** yazıldı (`readOutCursor`, `formatCursorReceipt`,
`createOffsetTracker` — `nabiz-core/bg-tasks`), opencode doğrudan core'dan
tüketiyor. Gerekçe: iki harness aynı protokolü konuşsun, Faz 3 birleştirmesi
bedavaya gelsin. Pi tarafı spec'e sadık local implementasyon taşır
(`readOffset` + `lastOffsetByTask` + aynı makbuz metni) çünkü pi loader'ın
workspace importunu çözdüğü bu makinede doğrulanamıyor; Faz 3'te pi core'a
bağlanırken dedup edilir.

Doğrulanan: core `tsc` + opencode `tsc` temiz; hızlı set 149 pass/0 fail/1 skip;
yeni cursor testleri (dilim/clamp/cap/tracker/makbuz/plugin makbuz+tekrar+tail
regresyonu) yeşil; pi `tsc --noEmit` syntax temiz (tek hata: ortamda `typebox`
yok — çevresel).
Kalan: spec §6 `pi -e` canlı doğrulama (uzun komut → cursor → next_offset →
tekrar uyarısı → offsetsiz tail regresyonu) — pi CLI olan makinede.

## Canlı doğrulama (2026-09-24, WSL1 RGSX-Linux)

LLM anahtarı yoktu; §6 adımları stub `pi` + GERÇEK hbmon daemon (0.2.2) ile
birebir koşuldu (`bg_run` → 6 satırlık iş, `sleep`li): **6/6 PASS** —
tail regresyon (eski format), cursor makbuz `offset=0 next_offset=7`,
ilk dilim içeriği, aynı offsette `[tekrar]` uyarısı, `offset=7` artımlı
devam (uyarısız), EOF sabitleme `(yeni çıktı yok)` + `next_offset=42`.
Ortam: node 22, pi 0.87.1 (extension yükleme doğrulandı:
`TOOLS:bg_run,bg_status,bg_logs,bg_kill`), hbmon 0.2.2.
Not: pi `resolveTask` id/prefix çözer (isim değil) — test uuid-prefix kullandı.

## Doğrulama

- `pi -e extensions/bg-hbmon.ts` ile: uzun komut → `bg_logs` (cursor al) →
  `offset=next_offset` ile devam (yalnızca yeni çıktı) → aynı offset tekrarı
  (uyarı metni görünür).
