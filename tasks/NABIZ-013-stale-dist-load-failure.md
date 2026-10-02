---
id: NABIZ-013
title: "stale dist → plugin tamamen yüklenemiyor (SyntaxError: Export named … not found)"
status: todo
priority: P2
created: 2026-10-02
updated: 2026-10-02
labels: [build, plugin, opencode-compat, dev-workflow]
depends_on: []
---

# NABIZ-013 — stale `dist/` plugin'i tümden düşürüyor

## Amaç

V2 `plugin/index.ts`'yi **yerinde `.ts` olarak** yüklüyor. Bu dosya
`nabiz-core`'den import zinciri kuruyor ve `nabiz-core` paketi
`package.json#exports` üzerinden **`dist/`'e** çözülüyor. Sonuç: `src`
değiştiği anda, `dist` derlenene kadar **tüm nabız plugin yüzeyi**
(6 plugin + 7 tool + hook'lar) yüklenemiyor.

Canlı 2026-10-02'de: `bg-tasks.ts`'ye `shellArgv` eklendi, `dist` derlenmeden
plugin yeniden yüklenmeye çalışıldı →

```
failed to load plugin
  target="…\packages\harness-opencode\plugin"
  cause="SyntaxError: Export named 'shellArgv' not found in module
         '…\packages\core\dist\bg-tasks.js'"
```

04:20–04:32 arası **9 kez**. `npm run build` sonrası düzeldi.

## Neden önemli

- Hata **sessiz değil** (log'da WARN) ama **çok geç** fark edilir: 7 tool
  bir anda kaybolur, `opencode mcp list` yeşil kalır (MCP ayrı yükleme
  yolundan geliyor), yani "her şey çalışıyor" izlenimi sürer.
- NABIZ-011'in sınıf kardeşi: tip/derleme değil, **yükleme zinciri**
  kırılganlığı.

## Kapsam

- Yapılacaklar
  - `plugin/package.json` içinde `nabiz-core` import'unu `dist` yerine
    **`src`**'e bağlayan bir çözümleme kuralı araştırılacak (V2 `.ts`
    yüklemesi `src`'i de çözebiliyorsa zincir kırılması biter —
    **önce ölç**, varsayımla kod değiştirme).
  - Ya da geliştirme akışını zincire bağlayan bir güvence: `pretest`
    zaten `npm run build` çalıştırıyor; **`plugins/` altında bir dosya
    değiştiyse core'u derleyen** bir kontrol (watch veya basit bir
    `scripts/check-dist.mjs` + CI kapısı).
  - README'ye "core'u değiştirdiysen önce `npm run build`" notu.
- Yapılmayacaklar
  - `dist/`'i repoya commit etmek.
  - `plugin/index.ts`'nin tek-entrypoint yapısı (NABIZ/V2 kuralı).

## Uygulama Planı

1. **Ölç**: `plugin/index.ts`'ten `nabiz-core/*` import'unu `../core/src/*`
   yoluna çevirip servis yeniden yükleniyor mu — çalışıyorsa en küçük
   çözüm bu. Çalışmıyorsa çözüm 2'ye geç.
2. `scripts/check-dist.mjs`: `core/src` en yeniyse `core/dist` eskiyse
   **exit 1** + "önce `npm run build`" mesajı. CI'ya ve `setup.mjs`'in
   `checkRepo`'suyla aynı disipline bağlanır.
3. Kilit: test, `core/src` yeni `dist` eski iken kilidin **kırmızı**
   olduğunu gösterir (geçici dosya + mtime).

## Etkilenen Dosyalar

- `packages/harness-opencode/plugin/index.ts` ve/veya `plugin/package.json`
- `packages/harness-opencode/scripts/` (yeni `check-dist.mjs`)
- `packages/harness-opencode/README.md`

## Doğrulama

- `core/src`'de bir export ekle, `npm run build` **çalıştırma**, log'da
  `failed to load plugin` **yok** (çözüm 1 ise).
- Çözüm 2 ise: `check-dist.mjs` o durumda exit 1, build sonrası exit 0.
- Tam süit yeşil; `opencode mcp list` ve 7 tool görünür.
