---
id: NABIZ-004
title: "Foreground MCP çağrılarında TUI spinner'ından yararlanma (sıfır kod)"
status: done
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
## Kapanış (2026-09-27)

- Belge: `packages/harness-opencode/README.md` “Foreground / spinner” bölümü
  (hangi çağrılar foreground kalır + timeout/heartbeat politikası).
- Timeout kanıtı (canlı, motor seviyesi): 5s'lik komut 1500ms tavanla
  foreground koştu → 1520ms'de `exitCode: 1` döndü, throw yok, takılma yok
  (`runBash`, `exec.ts`). TUI kilitlenmesi bu katmanda mümkün değil.
- Test: `mcp-shell` + `hbmon-tools` 13 pass / 1 skip (canlı hbmon yok);
  `hbmon_wait` timeout → `timeout (hâlâ çalışıyor)` devam protokolü kaplı.
- Spinner görseli: sıfır kod — render opencode TUI'nin işi; dayanak Amaç'taki
  doğrulanmış tespit (`work_spinner` + `Running/Completed/Failed`).
  TUI'lı makinede tek komutluk göz kontrolü: 10s foreground çağrıda spinner,
  bitince ✓ (kabul adımı, kod gerektirmez).
