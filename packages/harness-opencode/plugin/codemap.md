# packages/harness-opencode/plugin/

## Responsibility
Kurulabilir tek-entrypoint V2 paketi (id `nabiz`). Config `plugins`
girdisi bu dizini gösterir; dizinden yalnız `index.ts` yüklenir.

## Design
- `index.ts` — altı alt-plugin setup'ını keşif sırasıyla (alfabetik) koşturur;
  paylaşılan `options` çantası + `<plugin-id>` alt-çantası (`scopedOptions`).
- `enabled:false` (çanta kökünde) tek kill-switch: hiçbir hook/tool kaydolmaz.
- `package.json` — paket bildirimi.

## Flow
1. Host `index.ts` → `Plugin.define({id: "nabiz", setup})`.
2. `setup(ctx)` → her alt-plugin `sub.setup({...ctx, options: scoped})`.
3. Cleanup'lar ters sırada toplanır.

## Integration
- Altında: `../plugins/*` (kaynak `.ts`, yerinde yüklenir).
- Config: `plugins: ["<pkg>/plugin"]`; `plugin:` paket-dizini girdisi etkisizdir.
