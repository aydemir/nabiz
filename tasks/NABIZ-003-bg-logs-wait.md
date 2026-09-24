---
id: NABIZ-003
title: "bg_logs wait_ms (hbmon wait reuse ile bloklayan okuma)"
status: todo
priority: P2
created: 2026-09-23
updated: 2026-09-23
labels: [bg-hbmon, polling]
depends_on: [NABIZ-001]
---

# NABIZ-003 — bg_logs wait_ms

## Amaç

Model bugün yeni çıktıyı görmek için `bg_logs`'u döngüyle çağırıyor (ya da
5s poller'a güveniyor). Bloklayan okuma ile tek çağrıda bekler, poll döngüsü
biter.

İlham: minimax-code `task_output(wait_ms≤30000)` — mevcut çıktı/terminal varsa
**hemen** döner (minimum bekleme değil), yoksa cap'e kadar bekler;
`effective_wait_ms` raporlanır.

## Kapsam

- Yapılacaklar
  - `bg_logs`'a `wait_ms` (cap 30000, aşım sessizce kırpılır + hint).
  - Gerçekleme: yeni mekanizma YOK, daemon'daki mevcut bloklayan
    `hbmon wait --until done,failed,dep_missing,timeout --timeout` reuse edilir;
    süre dolmadan yeni `.out` baytı görülürse erken dön (NABIZ-001 cursor ile).
  - Terminal task + mevcut (okunmamış) çıktı → beklemeden hemen dön.
  - Yanıta `effective_wait_ms + timed_out` ekle.
- Yapılmayacaklar
  - Poller değişikliği (bildirim yolu ayrı kalır).
  - Soft-yield auto-background: pi'nin `bash` tool'u intercept edilemediği için
    mimari engel — bilinçli olarak kapsam dışı (bkz. KANBAN Ertelenenler).

## Uygulama Planı

1. NABIZ-001 cursor'ı önkoşul (offset tabanı olmadan wait anlamsız).
2. `wait_ms>0` ise: önce oku → yeni çıktı/terminal varsa dön; yoksa
   `hbmon wait` çağır (timeout = wait_ms) → uyandıktan sonra tekrar oku.
3. Tool description'a bekleme semantiğini ekle (minimax metni örnek alınır).

## Etkilenen Dosyalar

- `extensions/bg-hbmon.ts` (`bg_logs` tool)

## Doğrulama

- `sleep 5` task'ında `bg_logs wait_ms=30000` → ~5s'de döner (30s beklemez).
- Terminal task'ta `wait_ms=30000` → hemen döner.
- `wait_ms=99999` → 30000'e kırpılır + hint metni görünür.
