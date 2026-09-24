# Migrasyon planı: opencode-plugins → nabiz monorepo

Karar: `docs/decisions.md` (2026-09-24 04:37) — tek repo `aydemir/nabiz`,
harness başına ayrı paket + paylaşılan core; hbmon daemon ayrı repoda kalır.
Marka: pi harness = `nabız`.

## Hedef yapı

```
nabiz/
  packages/core/               # host-bağımsız motor (saf TS, opencode/pi importu YOK)
    src/{bg-tasks,build-tracker-disclosure,cpu-liveness-disclosure,
         disclosure,hbmon-tools,prune,raw-refill,settle-notice,
         truncation-notice}.ts
  packages/harness-opencode/   # opencode adaptörü (6 plugin + server.ts barrel)
    src/*.ts + mcp-bash-tools/ + scripts/ + tests/
  extensions/                  # pi adaptörü (mevcut; Faz 3'te core'a bağlanır)
  docs/{port-notes,migration-plan,decisions}.md
```

Kök `package.json` pi paketidir (`pi.extensions: ["./extensions"]` korunur);
üzerine `"workspaces": ["packages/*"]` eklenir. Paket adları: `nabiz-core`,
`nabiz-opencode` (pi paketi kökte `nabiz` olarak kalır).

## Faz 1 — core (bu faz)

1. `packages/core/{package.json,tsconfig.json,src/*.ts}` iskeleti.
2. `opencode-plugins/plugins/lib/*.ts` (9 dosya) → `packages/core/src/` (kopya;
   history opencode-plugins arşivinde kalır).
3. Kural kilidi: `core` içinde `@opencode-ai/plugin` ve
   `@earendil-works/pi-coding-agent` importu YASAK (grep gate).
4. `tsc` build temiz.

## Faz 2 — harness-opencode

1. `opencode-plugins/plugins/{6 plugin + server.ts}` →
   `packages/harness-opencode/src/`; `./lib/*.js` importları `nabiz-core`'a çevrilir.
2. `plugins/mcp-bash-tools/` → `packages/harness-opencode/mcp-bash-tools/`
   (nested workspace korunur).
3. `scripts/` + `tests/` taşınır; testler `../dist` yerine yeni dist'e bakar.
4. `scripts/setup.mjs` yol güncellemesi (repo kökü → `packages/harness-opencode`).
5. `npm run build` temiz + suite yeşil (setup 14/14, hbmon 11+1skip,
   bg hızlı 8/8, mcp-shell 2/2) + `setup --check` temiz.
6. opencode getLegacyPlugins kuralı korunur (barrel sadece function export).

## Faz 3 — pi core'a bağlanır (sonra)

`extensions/hbmon.ts` + `bg-hbmon.ts` içindeki kopya motor
(`runHbmon`, `summarizeWait`, handshake — bkz `docs/port-notes.md` Faz 1/2)
`nabiz-core` importuna çevrilir. Davranış testi: aynı handshake/özet/exit
haritası (canlı daemon smoke). `port-notes.md` güncellenir.

## Faz 4 — arşiv (son)

1. `docs/decisions.md` nabız'a taşınır (marka + yapı kararları dahil).
2. opencode-plugins README'sine yönlendirme (`→ aydemir/nabiz/packages/harness-opencode`),
   repo arşivlenir. `index.json`/`tasks/` history için salt-okunur kalır.

## Kurallar

- Geriye uyumluluk: plugin public API + disclosure metinleri değişmez.
- Test ile bitir: her faz `tsc` + ilgili suite yeşil olmadan kapanmaz.
- Yarım iş yok: faz bitmeden sonraki faza geçilmez.
