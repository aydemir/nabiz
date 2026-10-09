# packages/

## Responsibility
npm-workspaces monorepo paketleri.

## Design
- `core/` (`nabiz-core`) — saf motor, harici bağımlılıksız.
- `harness-opencode/` (`nabiz-opencode`) — opencode adaptörü.

## Integration
- Workspace linkleri symlink'tir (`node_modules/nabiz-core` → `packages/core`);
  Windows'ta symlink yetkisi gerekir (NABIZ-006).
- Registry: `nabiz-core` ve `nabiz-opencode` npm'de yayında
  (`npm install nabiz-core` / `npm install nabiz-opencode`); kök paket
  `private:true` — yanlışlıkla monorepo yayını engellenir.
