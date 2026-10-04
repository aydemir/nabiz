# packages/harness-opencode/scripts/

## Responsibility
Kurulum + bekçi script'leri (canlı config ve build izleme; testler değil).

## Design
- `setup.mjs` — tamset kurulum: `run()` çekirdeği (`--yes/--dry-run/--check`),
  `checkRepo` (artifact varlığı) + `checkDist` (NABIZ-013 tazelik kapısı),
  `computePlan`/`applyPlan` (yedekli yazma), V1 MCP girdisini V2
  `mcp.servers`'a taşıma, yabancı girdiye dokunmama.
- `check-dist.mjs` — core `src`/`dist` mtime karşılaştırması (bayatsa exit 1).
- `bg-wake.mjs` — bg bitince `opencode run` ile aynı oturumu uyandıran bekçi.
  Artık **yedek**: native `session.synthetic` düştüyse `--claim-dir/--claim-uuid`
  ile enjeksiyonu atlar; claim yoksa (süreç öldü / native push başarısız) devralır.
- `build-mon.mjs`, `hbmon-build-mon.mjs` — build izleme yardımcıları.
- `cpu-liveness-probe/`, `timeout-kill-probe/` — izole prob dizinleri.

## Flow
1. `setup.mjs --check` → repo kapıları → plan önizleme (yazmaz).
2. `--yes` → yedek (`opencode.jsonc.bak.<ts>`) → yaz → symlink temizliği.

## Integration
- Hedef: `~/.config/opencode/opencode.jsonc` (yalnız nabız girdileri).
- Testler: `tests/setup.test.mjs`, `tests/check-dist.test.mjs` (`run()` çekirdeğini çağırır).
