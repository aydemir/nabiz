# Repository Atlas: nabiz

## Project Responsibility
Opencode için bağlam-ekonomisi + build-gözlem adaptörü: saf motor
(`nabiz-core`) ve opencode arayüzü (`nabiz-opencode`), hbmon daemon
destekli uzun-build takibiyle.

## System Entry Points
- `packages/harness-opencode/plugin/index.ts` — kurulan plugin (id `nabiz`).
- `packages/harness-opencode/scripts/setup.mjs` — canlı config kurulumu.
- `packages/core/src/hbmon-tools.ts` — daemon istemci motoru.
- `packages/harness-opencode/plugins/opencode-hbmon.ts` — 7 tool
  (`hbmon_*`, `bg_*`, namespace `nabiz`).
- `extensions/hbmon.ts` + `extensions/bg-hbmon.ts` — pi yüzeyi
  (3 `hbmon_*` + 4 `bg_*` tool, `/bg` + `/bg-status` komutları).

## Directory Map (Aggregated)
| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `packages/core/src/` | Saf motor: hbmon istemcisi, bg kayıtları, kırpma/bildirim biçimleyiciler. | [View Map](packages/core/src/codemap.md) |
| `packages/harness-opencode/plugins/` | 6 V2 plugin + MCP bash-tools sunucusu. | [View Map](packages/harness-opencode/plugins/codemap.md) |
| `packages/harness-opencode/plugin/` | Tek-entrypoint kurulum paketi (id `nabiz`). | [View Map](packages/harness-opencode/plugin/codemap.md) |
| `packages/harness-opencode/scripts/` | Kurulum (`setup.mjs`) + bekçi scriptleri. | [View Map](packages/harness-opencode/scripts/codemap.md) |
| `packages/harness-opencode/tests/` | `node --test` suite (opencode yüzeyinin tek regresyon kapısı). | — |
| `extensions/` | Pi-agent için hbmon/bg portları (opencode dışı). | [View Map](extensions/codemap.md) |
| `scripts/` | Repo düzeyi symlink ön-kontrolü + pi uyumluluk kapısı. | [View Map](scripts/codemap.md) |

## Kritik Bağımlılıklar
- Host plugin `.ts`'i kaynaktan, `nabiz-core`'u `dist/`'ten çözer → bayat
  dist tüm bundle'ı düşürür (`scripts/check-dist.mjs`, NABIZ-013).
- Tool namespace kuralı: segment `^[A-Za-z0-9_-]{1,64}$` (NABIZ-011).
- MCP config V2 şekli: `mcp.servers.<ad>` + `disabled` (NABIZ-012).
- Pi tarafı: `@earendil-works/pi-coding-agent` ve `typebox` host sağladığı
  paketlerdir — `dependencies`'te değil `peerDependencies: "*"` + devDependency
  olarak durur (pi dokümanı: kopyalanmış sınıf/registry riski).

## Doğrulama Kapıları
- `npm run build` — workspace'ler (`dist/`), `tsc` 1024 MB heap tavanıyla.
- `npm run lint` — oxlint tüm repo, 0 warning hedefi.
- `npm run typecheck:ext` + `npm run check:pi` — pi uyumluluğu (tipler +
  canlı yükleme).
- `npm test` (paket içinden) / `npm run test:lowmem` (sıralı) — opencode yüzeyi.
