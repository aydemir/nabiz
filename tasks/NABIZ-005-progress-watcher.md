---
id: NABIZ-005
title: "Background işler için progress watcher (event-driven, polling yok)"
status: done
priority: P3
created: 2026-09-27
updated: 2026-09-27
labels: [build-mon, hbmon, progress, tui]
depends_on: []
---

# NABIZ-005 — Background işler için progress watcher

## Amaç

`build-mon` / `hbmon` işleri detached koştuğu için TUI onları "çalışıyor"
göremiyor; bugün yalnızca `[sn] settled` final bildirimi var. Ara durum
(`started/progress/done`) için event-driven bir ilerleme yüzeyi eklemek —
NABIZ-004'teki foreground yolunun tamamlayıcısı.

## Kapsam

- Yapılacaklar
  - Event formatı kararı: mevcut `events.jsonl` reuse edilebilir mi, yoksa
    minimal `progress.jsonl` (`job, state, ts, detail`) mi.
  - Tüketici yüzeyi: opencode `/api/event` akışına köprü mü, notice dosyası mı,
    yoksa MCP `bg_status` zenginleştirmesi mi (3 seçenek, 1'i seçilecek).
  - **Hedef kilidi geçerli:** polling YOK — watcher push/event-based olacak,
    TUI tarafı poll döngüsüne sokulmayacak (KANBAN.md'deki kilit).
- Yapılmayacaklar
  - TUI animasyon kodu (opencode tarafı).
  - hbmon daemon içi değişiklik (hbmon reposunun işi, TASK-050 tarafı).

## Karar (2026-09-27)

- Event formatı: YENİ DOSYA YOK — `events.jsonl` reuse. `build-mon.mjs` +
  `hbmon-build-mon.mjs` zaten aynı kayda yazıyor
  (`{ts, name, event, detail, log, exit?}`: STARTED/HEARTBEAT/STALLED/
  TIMED_OUT/OOM_SUSPECT/DEP_MISSING/PASSED/FAILED/ERROR/INTERRUPTED).
- Tüketici: MCP `bg_status` zenginleştirmesi (seçilen). Reddedilenler:
  `/api/event` köprüsü (tüketici sözleşmesi repo'da yok, TUI bizde değil);
  notice dosyası (pasif okuma = prompt disiplini, KANBAN kilidine aykırı).
- Motor: `packages/core/src/progress.ts` (`nabiz-core/progress`):
  `parseProgressLine` / `readLastProgress` / `formatProgress` — saf okuma,
  timer/izleyici döngü YOK. `bg_status`: bg kaydı yoksa name ile
  events'e düşer, eşleşme yoksa eski HATA (fail-open).

## Doğrulama

- 60s'lik build'de ara `progress` event'i düşüyor, final `settled` ile tutarlı.
- Hiçbir tüketici poll döngüsü kurmuyor (kodda `setInterval`-benzeri yok).
- `events.jsonl` yokluğunda watcher sessiz geçiyor (fail-open).

## Kapanış (2026-09-27)

- Test: `progress.test.mjs` 7/7 (parse, son-eşleşme, fail-open, format,
  polling-taraması, bg_status fallback, BUILD_MON_DIR).
- Canlı: `build-mon --name nabiz005 --heartbeat 10 -- sleep 60` koşusunda
  25s'de `progress: HEARTBEAT ... 21sn geçti` okundu; final PASSED ile tutarlı.
- `npm run build` temiz. pi `bg-hbmon` tarafı değişmedi (snapshot modeli +
  NABIZ-003 `wait_ms` yeterli görüldü).
