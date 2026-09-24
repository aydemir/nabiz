# nabız — Task Board (2026-09-23)

Kaynak: minimax-code arka plan mimarisi incelemesi (2. göz dahil). hbmon
daemon tarafı işler hbmon reposunda (`TASK-050`); burası yalnızca extension
katmanıdır.

## Hedef Kilidi

> **hbmon'un vaadi extension'da bozulmaz:** restart'ı atlatma, context
> ekonomisi, polling YOK disiplini prompt'ta değil runtime'da da tutulur.

## Board

| ID | Başlık | Status | Priority |
|----|--------|--------|----------|
| NABIZ-001 | bg_logs cursor (offset/next_offset/truncated + tekrar uyarısı) | todo | P1 |
| NABIZ-002 | Task registry persist (restart durability) | todo | P1 |
| NABIZ-003 | bg_logs wait_ms (hbmon wait reuse) | todo | P2 |

Sıra: `NABIZ-001 → NABIZ-002 → NABIZ-003` (003, 001'e bağlı; 001-002 bağımsız,
paralel yapılabilir).

## Ertelenenler (bilinçli, 2. göz kararı)

- **Soft-yield auto-background:** pi'nin `bash` tool'u extension'dan intercept
  edilemez; mimari engel. Prompt heuristiği ("sürecek işi `bg_run` ile başlat")
  yeterli.
- **Delivery burst limiti:** minimax'teki (60s'de 3 turn) onlarca task'lı cloud
  içindi; pi oturumunda 1-3 task var, fırtına kanıtı yok. Mevcut durable
  bildirim + `adoptOrphans` yeterli.
- **Watchdog default tavan:** minimax `max(30dk, explicit)` yapıyor ama hbmon
  dev server/watcher destekliyor — kör default server'ları öldürür. Kind-aware
  tavan gerektirir; kanıt birikince hbmon tarafında ayrı TASK açılır.
