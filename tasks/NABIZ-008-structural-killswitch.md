---
id: NABIZ-008
title: "hbmon plugin kill-switch'i yapısal yap (7 tool kayıt altında kalıyor)"
status: todo
priority: P2
created: 2026-09-27
updated: 2026-09-27
labels: [bg-hbmon, config, context-economy]
depends_on: []
---

# NABIZ-008 — hbmon plugin kill-switch'i yapısal yap

## Amaç

`{"opencode-hbmon": {"enabled": false}}` verildiğinde plugin hâlâ **7 tool'u
modele sunuyor**; yalnız her `execute` `"… kapalı (enabled:false)"` metni
döndürüyor. Kapatılan plugin her istekte 7 tool yuvası işgal ediyor ve model
hâlâ o isimleri görüyor — `enabled:false` "kapat" değil, "her çağrıda hata
ver" demek oluyor.

İlham: minimax-code capabilityyi **şemaya uyguluyor** —
`packages/agent-tools/src/desktop/local-bash-contract.ts:31`:

```ts
const schema = capabilities.background ? base : Type.Omit(base, ['run_in_background']);
```

Tool yapısal olarak yok oluyor, üstelik `timeout` açıklaması da koşula göre
yeniden yazılıyor. Yani mcode "açıklama değiştir, davranış değiştir" diyor;
nabiz "açıklamayı değiştir, tool'u yerinde bırak, hata döndür" diyor.

**Depo içinde zaten doğru örnek var:** `opencode-build-tracker.ts:143`
`enabled:false` durumunda **hiç hook kaydetmeden** dönüyor. hbmon bunun
istisnası.

## Kapsam

- Yapılacaklar
  - `opencode-hbmon.ts:123-129` (`setup`): `config.enabled === false` ise
    `ctx.tool.transform(...)` **hiç çağrılmadan** dön — build-tracker
    deseninin birebir uygulanması.
  - Yedi `execute` gövdesindeki `if (config.enabled === false) return …`
    satırlarını kaldır (`:157,188,205,227,295,332,353`); ölü yol kalmasın.
  - **Kapatıldığında kullanıcıya görünür bir iz bırak:** tool yuvası
    kaybolduğunda "neden yok" sorusu doğar. Doğru kanal **disclosure**
    (`session.hook("context")`), stub değil — diğer beş plugin'in yaptığı gibi.
    Tek satırlık not: `opencode-hbmon` kapalı, `bg_run` yok.
  - KANBAN/disclosure metinlerinin güncel `opencode-hbmon` anahtarıyla
    tutarlı olduğunu doğrula (`plugin/index.ts:42-56` namespaced çanta).
- Yapılmayacaklar
  - **Kök çantadaki `enabled:false`** zaten doğru çalışıyor
    (`plugin/index.ts:62` her şeyi kısa devreye alıyor) — değiştirme.
  - `bg_*` tool **adlarının** değişmesi (LLM/test uyumu, `opencode-hbmon.ts:18-21`).
  - `hbmon_watch`/`hbmon_wait`/`hbmon_status` semantiği.

## Uygulama Planı

1. `setup` başına guard; `ctx.tool.transform` çağrısını korumalı yap.
2. Yedi `execute` guard'ını temizle.
3. Kapalıyken disclosure metni ekle (sentinel: `[hbmon-disabled]`, ayrı core
   modülü — `disclosure.ts`'nin notu gereği sabitler plugin dosyasında
   **string export** olamaz, `getLegacyPlugins` `Object.values` kuralı).
4. Test: `enabled:false` ile `tools/list` → 7 tool **hiç** görünmemeli.

## Etkilenen Dosyalar

- `packages/harness-opencode/plugins/opencode-hbmon.ts`
- `packages/core/src/` (yeni disclosure sabiti modülü)
- `packages/harness-opencode/tests/`

## Doğrulama

- `enabled:false` → `tools/list` çıktısında `bg_run`/`bg_logs`/`bg_status`/
  `bg_kill`/`hbmon_*` **yok**; doğrudan çağrı "unknown tool" döner.
- `enabled:true` (default) → 7 tool mevcut, davranış **bit-bazında** aynı.
- Kök `enabled:false` → hâlâ hiç plugin yüklenmiyor (mevcut davranış).
- Disclosure metni oturum açılışında bir kez görünür, tekrar etmez.
