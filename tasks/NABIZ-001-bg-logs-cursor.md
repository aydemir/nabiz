---
id: NABIZ-001
title: "bg_logs cursor protokolü (offset/next_offset/truncated) + tekrar-okuma uyarısı"
status: todo
priority: P1
created: 2026-09-23
updated: 2026-09-23
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

## Doğrulama

- `pi -e extensions/bg-hbmon.ts` ile: uzun komut → `bg_logs` (cursor al) →
  `offset=next_offset` ile devam (yalnızca yeni çıktı) → aynı offset tekrarı
  (uyarı metni görünür).
