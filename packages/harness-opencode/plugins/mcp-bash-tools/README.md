# nabiz MCP server (eski key: bash; daha eski ad: opencode-mcp-bash-tools)

MCP server (stdio) that exposes two schema-controlled alternatives to
opencode's native `bash` tool. Server-içi adlar `safe` / `raw`; opencode
TUI'de `<config-key>_<tool>` olarak görünür — config key `nabiz` olunca
TUI adları `nabiz_safe` / `nabiz_raw` olur:

| Server-içi ad | TUI adı (`nabiz` key ile) | Behavior | Schema-controlled args |
|---|---|---|---|
| `safe` | `nabiz_safe` | middle-prune + marker (default) | `max_chars`, `head_chars`, `tail_chars`, `timeout_ms` |
| `raw` | `nabiz_raw` | full output, no prune | `max_chars` (filesystem guard only), `timeout_ms` |

## Why

opencode's native `bash` tool has a fixed schema (`command`,
`description`, `timeoutMs`, ...). Plugin-only "bypass flags" like
`no_prune=true` or `disableForCalls=N` are documented in
`opencode-context-saver` plugin's disclosure — but they are silently
ignored by opencode because they are not part of the tool's schema.

This MCP server fixes that by exposing our **own** tools with **our**
schema. LLM can pick `nabiz_safe` (TUI adı; server-içi `safe`) or
`nabiz_raw` (TUI adı; server-içi `raw`) and the bypass actually works.

## Install

```bash
npm install
npm run build
```

Output: `dist/server.js`

## Register in opencode

Add to your `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "nabiz": {
      "type": "local",
      "command": ["node", "<repo>/packages/harness-opencode/dist/plugins/mcp-bash-tools/src/server.js"],
      "enabled": true
    }
  }
}
```
(`setup.mjs --yes` bunu otomatik yazar.)

Config key `nabiz` TUI adlarını belirler (`nabiz_safe`, `nabiz_raw`) —
ve `opencode-context-saver` plugin'in `skipTools` suffix kuralı bu adları
key'den bağımsız yakalar.

## Marker format

When `nabiz_safe` (server-içi `safe`) prunes, output looks like:

```
[Run ls /tmp]
file1.txt
file2.txt
...

[... pruned: 60000→400 chars (99.3% saved). For raw output, call nabiz_raw with the same command. ...]

...last lines of file...
```

LLM sees this marker and knows the exact tool call to make for raw
output (schema-controlled, actually works).

## Plugin interaction

`opencode-context-saver` plugin (TASK-110) skips MCP tool names by
suffix rule (`nabiz_safe`, `nabiz_raw` match any `<key>_nabiz_safe` /
`<key>_nabiz_raw`) so the two layers don't double-prune — server key
renames can't silently break the skip.

## Platform

- POSIX: shell `/bin/bash` (TASK-115: dash orphan bırakır, bash şart).
- Windows (2026-09-08, ilk win32 canlı testi): `/bin/bash` ENOENT
  veriyordu, tüm komutlar `[exit 1]` dönüyordu. win32'de `ComSpec`
  (cmd) kullanılır — POSIX deyimleri çalışmaz (bilinçli sınır),
  orphan-garantisi TEST EDİLMEDİ.
