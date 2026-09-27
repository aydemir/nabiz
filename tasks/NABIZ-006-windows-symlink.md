---
id: NABIZ-006
title: "Windows'ta npm workspace symlink (EPERM) sorunu"
status: todo
priority: P2
created: 2026-09-27
updated: 2026-09-27
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
- Yapılacaklar
  - Gerçek Windows makinede `node scripts/check-symlink.mjs` + `npm install`
    + `npm run build` kanıtı (kilitli kullanıcı hesabında preflight'ın
    exit 1 + çözüm mesajı verdiği de doğrulanmalı).
  - İlk CI koşusunu yeşil gör (push sonrası Actions sekmesi).

## Doğrulama

- Temiz Windows checkout'ta `npm install && npm run build` geçiyor.
- Belge + gerçek davranış tutarlı (önerilen yol denenmiş).
