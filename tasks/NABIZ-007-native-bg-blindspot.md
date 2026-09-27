---
id: NABIZ-007
title: "Opencode native background shell kör noktası (Shell finished)"
status: done
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
- Native background shell (`POST /session/:id/shell`) tool hattından geçmez;
  durum doğrudan `sessions.updatePart` ile yazılır
  (upstream: `prompt.ts:shellImpl` → `finish` → part completed).
- Çözüm bulundu (upstream `/root/opencode-upstream` + kurulu SDK 2.0.16):
  bus olayları `session.shell.started` (`data.shell.command`) /
  `session.shell.ended` (`data.shell.command` + `data.output.output`);
  plugin `ctx.event.subscribe()` hepsini görür. Çalışan binary
  (v2.0.18) `session.shell.ended` içerir, `session.next.*` içermez —
  eski adlar doğru olandır.

## Çözüm (2026-09-27)

- `opencode-build-tracker.ts` subscribe döngüsüne iki dal eklendi:
  `session.shell.started` → build komutuysa session aç;
  `session.shell.ended` → çıktıyı hata desenleriyle tara,
  success/failed kapat (started kaçsa bile ended tek başına kapatır).
  Build-dışı shell olayları yok sayılır (fail-open).

## Doğrulama

- `build-tracker.test.mjs` 21/21 (3 yeni NABIZ-007 testi: started açar,
  ended success/failed kapatır, build-dışı yok sayılır).
- Canlı TUI göz kontrolü (native background build bitiminde
  `nabiz:last-build` kaydı) kabul adımı olarak açık kalır — kod yolu
  testle kaplı, olay sözleşmesi binary'de doğrulandı.
