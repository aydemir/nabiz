---
id: NABIZ-005
title: "Background işler için progress watcher (event-driven, polling yok)"
status: todo
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

## Doğrulama

- 60s'lik build'de ara `progress` event'i düşüyor, final `settled` ile tutarlı.
- Hiçbir tüketici poll döngüsü kurmuyor (kodda `setInterval`-benzeri yok).
- `events.jsonl` yokluğunda watcher sessiz geçiyor (fail-open).
