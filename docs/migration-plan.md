# Migrasyon planı: opencode-plugins → nabiz monorepo

> Statü (2026-09-24): Faz 1 ✓ · Faz 2 ✓ · Faz 3 ✓ · Faz 4 kısmi
> (`docs/decisions.md` taşındı, README yönlendirmesi push'landı, repo arşivi bekliyor).

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

## Faz 1 — core (bitti ✓)

1. `packages/core/{package.json,tsconfig.json,src/*.ts}` iskeleti.
2. `opencode-plugins/plugins/lib/*.ts` (9 dosya) → `packages/core/src/` (kopya;
   history opencode-plugins arşivinde kalır).
3. Kural kilidi: `core` içinde `@opencode-ai/plugin` ve
   `@earendil-works/pi-coding-agent` importu YASAK (grep gate).
4. `tsc` build temiz.

## Faz 2 — harness-opencode (bitti ✓)

1. `opencode-plugins/plugins/{6 plugin + server.ts}` →
   `packages/harness-opencode/src/`; `./lib/*.js` importları `nabiz-core`'a çevrilir.
2. `plugins/mcp-bash-tools/` → `packages/harness-opencode/mcp-bash-tools/`
   (nested workspace korunur).
3. `scripts/` + `tests/` taşınır; testler `../dist` yerine yeni dist'e bakar.
4. `scripts/setup.mjs` yol güncellemesi (repo kökü → `packages/harness-opencode`).
5. `npm run build` temiz + suite yeşil (setup 14/14, hbmon 11+1skip,
   bg hızlı 8/8, mcp-shell 2/2) + `setup --check` temiz.
6. opencode getLegacyPlugins kuralı korunur (barrel sadece function export).

## Faz 3 — pi core'a bağlanır (bitti ✓ 2026-09-24)

`extensions/hbmon.ts` motoru (`runHbmon`, `watchBuild`, `waitBuild`,
`statusBuild`, `summarizeWait`) `nabiz-core/hbmon-tools`'tan geliyor (286→106
satır); `bg-hbmon.ts` özdeş yardımcıları (`outFromSock`, `formatCursorReceipt`,
`createOffsetTracker`) `nabiz-core/bg-tasks`'tan alıyor. Bilinçli yerel
kalanlar: `readOffset`, `mapState`, `exitFromLogFile`, registry (NABIZ-002),
wait döngüsü (NABIZ-003) — gerekçeler `docs/port-notes.md` Faz 3'te.
Doğrulama: `tsc --noEmit` temiz + mock-pi canlı smoke 13/13.

## Faz 4 — arşiv (kısmi: yönlendirme push'landı, arşiv bekliyor)

1. `docs/decisions.md` nabız'a taşındı ✓ (marka + yapı kararları dahil;
   kaynaktaki 3 kayıt `opencode-plugins@13a0fa1` ile doğrulandı).
2. opencode-plugins README'sine yönlendirme ✓ push'landı (`f136026`,
   `→ aydemir/nabiz/packages/harness-opencode`); repo arşivi ⏳ bekliyor
   (ağaç kirli olduğu için ertelendi). `index.json`/`tasks/` history için
   salt-okunur kalır.

## Kurallar

- Geriye uyumluluk: plugin public API + disclosure metinleri değişmez.
- Test ile bitir: her faz `tsc` + ilgili suite yeşil olmadan kapanmaz.
- Yarım iş yok: faz bitmeden sonraki faza geçilmez.
