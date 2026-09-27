---
id: NABIZ-004
title: "Foreground MCP çağrılarında TUI spinner'ından yararlanma (sıfır kod)"
status: todo
priority: P2
created: 2026-09-27
updated: 2026-09-27
labels: [tui, spinner, mcp]
depends_on: []
---

# NABIZ-004 — Foreground MCP çağrılarında TUI spinner'ı

## Amaç

Opencode TUI, `running` durumundaki her tool çağrısına otomatik `work_spinner`
animasyonu çiziyor (sunucu SSE event'i → istemci kozmetiği; doğrulanmış:
`app.exit` yanındaki `work_spinner` ayarı, `Running/Completed/Failed` durumları).
Nabız işleri foreground MCP tool olarak koştuğunda canlı "çalışıyor" göstergesi
sıfır kodla geliyor — bunu bilinçli kullanıma çevirmek.

## Kapsam

- Yapılacaklar
  - Hangi nabız çağrılarının foreground kalması gerektiğini belgelemek
    (`bg_run` kısa işler, `shell` bloklayan çağrılar, `POST /session/{id}/shell`).
  - Uzun build'lerde TUI kilitlenmesine karşı timeout/heartbeat politikası:
    opencode tool timeout eşiği nedir, aşımda graceful ne olur (kanıtla).
  - `harness-opencode` README'sine "spinner istiyorsan foreground çağır" notu.
- Yapılmayacaklar
  - TUI kodu değişikliği (opencode tarafı, bizde değil).
  - Yeni animasyon/ikon — render opencode'un işi.

## Doğrulama

- 10s'lik foreground çağrıda TUI'da spinner dönüyor, bitince `✓` oluyor.
- Timeout eşiği dokümante edilmiş, aşımda tool `error` dönüyor, TUI takılmıyor.

## İlerleme (2026-09-27)

- `packages/harness-opencode/README.md`: "Foreground / spinner" bölümü eklendi
  (hangi çağrılar foreground kalır + timeout/heartbeat politikası, kod kanıtlı).
- Kök `README.md` / `README.tr.md`: Windows symlink notu eklendi.
- Doğrulama (kod kanıtı): `npm run build` temiz; `mcp-shell` + `hbmon-tools`
  testleri 13 pass / 1 skip (canlı hbmon yok) — `wait: timeout (hâlâ çalışıyor)`
  ve `runBash` timeout davranışı testle kaplı.
- Kalan: canlı TUI kontrolü (10s foreground çağrıda spinner → ✓) — headless
  ortamda yapılamadı, TUI'lı makinede tek komutla doğrulanacak.
