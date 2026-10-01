---
id: NABIZ-006
title: "Windows'ta npm workspace symlink (EPERM) sorunu"
status: done
priority: P2
created: 2026-09-27
updated: 2026-10-01
labels: [windows, npm, workspaces, build]
depends_on: []
---

# NABIZ-006 — Windows'ta npm workspace symlink (EPERM) sorunu

## Amaç

Windows'ta `npm install` workspace linklerini symlink ile kurar
(`node_modules/nabiz-core` → `packages/core`) ve symlink yetkisi yoksa
`EPERM: operation not permitted, symlink` ile patlar.

## Kapsam

- Yapılan (2026-09-27): kök `README.md` / `README.tr.md` + `harness-opencode`
  README'sine kısa not eklendi (yönetici terminal / Geliştirici Modu).
  Düzeltme: önce önerilen `npm install --install-links=false` GERİ ALINDI —
  npm docs: "This option has no effect on workspaces", yani workspace
  linkleri her zaman symlink'tir, yetki şart.
- Yakalama (2026-09-27): `.github/workflows/ci.yml` eklendi
  (`build-linux`: `npm ci` + build + tam test; `build-windows`:
  kullanıcı akışının birebiri `npm install` + build + hedefli testler).
  Dürüst sınır: hosted runner'lar admin koşar, kilitli makinedeki EPERM
  birebir üremez — EPERM'i kurulum öncesi `scripts/check-symlink.mjs`
  fail-loud yakalar (tmpdir'de symlink dener, EPERM'de çözüm mesajı).
- Kanıt (PR #1, `ci/nabiz-004-006`): iki koşu da yeşil. Windows Server 2025
  logu: `npm install` 17s'de 402 paket, build temiz, `nabiz-core` +
  `nabiz-opencode` SYMLINK, hedefli testler 13 pass / 1 skip; linux'ta tam
  suite geçti. CI node 22'ye alındı (node 20 runner-deprecated + pi
  paketlerinden EBADENGINE uyarısı veriyordu).
- Yapılacaklar
  - Gerçek kilitli Windows hesabında `node scripts/check-symlink.mjs`'in
    exit 1 + çözüm mesajı verdiği doğrulanmalı (CI runner'ı admin olduğu
    için bu senaryo CI'da üretilemiyor).

## Kapanış (2026-09-28)

done — kanıt-bar istisnası (`docs/decisions.md`). Preflight + README + CI
yeterli. Kilitli-hesap canlı EPERM kanıtı opsiyonel (NABIZ-006b P3).

## Doğrulama

- Temiz Windows checkout'ta `npm install && npm run build` geçiyor.
- Belge + gerçek davranış tutarlı (önerilen yol denenmiş).

## Canlı kanıt — Windows 10 Pro (2026-10-01, bu makine)

Ortam: Windows 10 Pro 2009 (Build 19045), Node v24.19.0, admin olmayan
hesap, Geliştirici Modu kapalı.

- `node scripts/check-symlink.mjs` → exit 1 + çözüm mesajı
  (`hata: symlink yetkisi yok...`). NABIZ-006b P3 kanıtı bu makinede
  üretildi: CI admin runner'ı bu dalı üretemiyordu, kilitli hesap üretiyor.
- `npm run build` → temiz (core + opencode, exit 0).
- `setup.test.mjs` → 20 pass / 1 skip (skip:
  `planSymlinkCleanup` EPERM dalı, `tests/setup.test.mjs:176`).
- `isOursMcpEntry` Windows yolu: `join()` backslash üretir, `endsWith`
  ıskalar — `replaceAll("\\", "/")` ile kilitlendi
  (`scripts/setup.mjs:65`, testler `tests/setup.test.mjs:96,118`).
- `tree-kill.js` win32: yok-hükmündeki PID'de `taskkill` exit 128 verir
  (`ERROR: The process "99999999" not found`), Linux ESRCH karşılığıdır.
  Önce err'e düşüyordu (`cpu-liveness-probe.test.mjs:206` fail); 128
  yutulunca 9/9 pass (`scripts/cpu-liveness-probe/tree-kill.js:89-99`).

Kalan Windows açıkları (düzeltme yok, delil):

- `bg-tasks.test.mjs` 15 pass / 5 fail / 1 skip: 1 fail `hbmon` ikilisi
  yok (`bg-tasks.test.mjs:214`); 4 fail adapter/bg-wake exit 1≠0
  (`:261,:429,:441,:474`) — stub spawn/pipe, Windows'ta bakılmalı.
- `build-mon.test.mjs` 7 pass / 2 fail: `:98` `failed.log.endsWith("/arch")`
  Windows `\` ayracında tutmaz; `:228` TERM→exit 143 sinyali Windows'ta
  aynı değil.
- `cpu-liveness` win32 okuyucu (`Get-Process TotalProcessorTime`) hâlâ
  UNTESTED (`packages/core/src/cpu-liveness-disclosure.ts:33`).
