---
id: NABIZ-007
title: "Opencode native background shell kör noktası (Shell finished)"
status: todo
priority: P2
created: 2026-09-27
updated: 2026-09-27
labels: [opencode, background, shell, event]
depends_on: []
---

# NABIZ-007 — Native background shell bitince nabiz yok

## Sorun

Opencode'un kendi background shell'i bitince TUI `↳ Shell finished · <komut>`
basıyor ama nabiz'den ses yok: build-tracker kaydı yok, `[sn]` notu yok.

## Kök neden (2026-09-27, kod kanıtlı)

- `↳ Shell finished` metni repo'da YOK — opencode app/TUI render'ı.
- nabiz hook'ları (`tool.execute.before/after`) tool-sonuç hattında çalışır;
  native background tamamlanması bu hattan geçmiyor (araştırıldı:
  `@opencode/plugin` SDK stub; `shell` domain'de sadece `create.before`,
  `event` domain'de `subscribe` var, bitim olayı sözleşmesi bilinmiyor —
  `@opencode/client` paketi kurulu değil, doğrulanamadı).

## Seçenekler

1. `event.subscribe` ile server olay akışını dinleyip shell-bitim olayını
   yakalamak (kanıtlanmadı — canlı opencode oturumunda denenecek).
2. Olmazsa bilinçli kapsam-dışı: uzun iş `bg_run` / `hbmon_watch` ile koşulur
   (NABIZ-004 felsefesi: "bildirim istiyorsan bg_run"). Geçici çözüm bu.

## Doğrulama

- Native background `sleep 5` bitiminde build-tracker/`[sn]` izi düşüyor
  (seçenek 1), ya da kapsam-dışı kararı + README geçici-çözüm notu (seçenek 2).
