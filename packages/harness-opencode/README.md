# nabiz-opencode

nabiz adapter for OpenCode 2.x (`@opencode/plugin`): six plugins
(`Plugin.define({ id, setup })`), plus MCP bash-tools, scripts, and tests.
Imports the shared engine (`nabiz-core`) — no copied motor code.

Part of [`aydemir/nabiz`](https://github.com/aydemir/nabiz).

## Plugins (V2 discovery)

`opencode-context-saver`, `opencode-build-tracker`,
`opencode-truncation-noticer`, `opencode-cpu-liveness`,
`opencode-settle-noticer`, `opencode-hbmon` — plus MCP server
`mcp-bash-tools` (`nabiz_safe` / `nabiz_raw`).

V2 gerçeği: `plugins` config girdisi DOSYA kabul etmez
("configured plugin path must be a directory"); bir dizinden SADECE
`index.ts` yüklenir. Bu yüzden `plugin/` TEK ENTRYPOINT'tir
(`index.ts` altıyı birden `nabiz` id'siyle kaydolur, hook sırası
alfabetik dosya sırasıyla aynı). `setup.mjs --yes` config'e paket
dizinini yazar, repo'ya ait stale dosya girdilerini temizler, eski
symlink-modundan kalan nabiz symlink'lerini kaldırır (çift kayıt
önlenir) ve `mcp.nabiz` yolunu bu repo dist'ine çevirir.

## Options (V2 `{package, options}`)

```jsonc
{
  "plugins": [
    {
      "package": "/root/nabiz/packages/harness-opencode/plugin",
      "options": {
        "thresholdMs": 60000,
        "opencode-truncation-noticer": { "enabled": false }
      }
    }
  ]
}
```

Tek çanta paylaşılır (her plugin kendi anahtarını okur); `<plugin-id>`
alt-çantası üstüne yazar. `enabled: false` (kök) tüm paketi kapatır
(tek kill-switch). Resmi şemada `pluginOptions` anahtarı YOKTUR (V1
artığı) — seçenekler buradan verilir.

## Build / test

```bash
npm run build --workspace nabiz-opencode   # tsc → dist/
npm test --workspace nabiz-opencode        # node --test suite
node packages/harness-opencode/scripts/setup.mjs --check
```

## Layout

- `plugins/` — the six V2 plugins (`export default Plugin.define(...)`;
  each file also loads standalone via discovery) + `server.ts` re-export barrel
  (not a plugin itself) and `mcp-bash-tools/`
- `plugin/` — the installable V2 package (single entrypoint `index.ts`,
  id `nabiz`; config `plugins` entry points here)
- `scripts/` — `setup.mjs`, `build-mon.mjs`, `hbmon-build-mon.mjs`,
  `bg-wake.mjs`, `cpu-liveness-probe/`, `timeout-kill-probe/`
- `tests/` — `node --test` suite (mirrors the opencode-plugins history,
  now running against `nabiz-core`)
