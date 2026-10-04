# nabız — Ajan Kuralları

Stil, opencode v2 (`~/opencode-upstream`, `AGENTS.md`) ile hizalıdır.
Aşağıdakiler upstream kurallarının bu repoya (npm + `node --test` + `tsc`)
uyarlanmış halidir; çelişki yok, yalnızca toolchain farkı var.

## Komutlar (kökten)

- `npm run build` — tüm workspace'leri derler (`tsc`, `dist/`; her `tsc`
  çağrısı `node --max-old-space-size=1024` altında çalışır).
- `npm run format` / `format:check` — prettier (`semi: false`, `printWidth: 120`).
- `npm run lint` — oxlint, tüm repo (`oxlint .`, 0 warning hedefi).
- `npm run typecheck:ext` — `extensions/` için `tsc --noEmit`
  (pi 1.0.x tiplerine karşı; `tsconfig.extensions.json`).
- `npm run check:pi` — pi uyumluluk kapısı: extension'ları pi'nin kendi
  jiti'siyle yükler, tool/komut sözleşmesini doğrular
  (`scripts/check-pi-ext.mjs`).
- `npm run test:lowmem` — opencode paketinin testleri, sıralı
  (`--test-concurrency=1`); `npm test` paket içinden paralel koşar.
- Testler kökten koşmaz; paket dizininden `npm test`
  (`node --test --test-reporter=spec`; `scripts/bg-wake.mjs` göreli yolu
  paket cwd'si ister).

## Stil

- Noktalı virgül yok (prettier `semi: false`); satır genişliği 120.
- Yıldız import yok (`import * as fs` yasak) — adlandırılmış import kullanılır.
  Tek istisna: modül-şekil iddiası yapan test (`server-entry.test.mjs`),
  gerekçesi dosyada yorumla yazılıdır.
- Import alias yok (`x as y` yasak).
- `const` tercih edilir; early return; `else`'ten kaçınılır.
- Tek kullanımlık helper çıkarılmaz; yardımcılar ana export'un altında,
  desteklediği koda yakın durur.
- `any` yok; gereksiz tip anotasyonu yok (inference yeterliyse).
- Açıklayıcı olmayan yorum yok; şaşırtıcı kısıtlar ve canlı-kanıt notları
  yorumlanır.
- Ölü kod tutulmaz (oxlint `no-unused-vars` temiz kalır).

## Sözleşmeler

- Plugin dosyası yalnızca `default` export eder (string export yasağı:
  `getLegacyPlugins` `Object.values` kuralı). Sabitler `nabiz-core`
  alt yolundadır.
- `enabled:false` yapısal kill-switch'tir: hook/tool kaydolmaz, tek iz
  `session.hook("context")` disclosure'ıdır.
- Davranış değişikliği testle kilitlenir; yeni test üretim yolunu hedefler,
  kopyayı değil.

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.
