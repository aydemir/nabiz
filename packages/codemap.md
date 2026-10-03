# packages/

## Responsibility
npm-workspaces monorepo paketleri.

## Design
- `core/` (`nabiz-core`) — saf motor, harici bağımlılıksız.
- `harness-opencode/` (`nabiz-opencode`) — opencode adaptörü.

## Integration
- Workspace linkleri symlink'tir (`node_modules/nabiz-core` → `packages/core`);
  Windows'ta symlink yetkisi gerekir (NABIZ-006).
