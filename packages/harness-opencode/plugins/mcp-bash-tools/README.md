# bash (eski ad: opencode-mcp-bash-tools)

MCP server (stdio) that exposes two schema-controlled alternatives to
opencode's native `bash` tool. Server-içi adlar `safe` / `raw`; opencode
TUI'de `<config-key>_<tool>` olarak görünür — config key `bash` olunca
TUI adları `bash_safe` / `bash_raw` olur:

| Server-içi ad | TUI adı (`bash` key ile) | Behavior | Schema-controlled args |
|---|---|---|---|
| `safe` | `bash_safe` | middle-prune + marker (default) | `max_chars`, `head_chars`, `tail_chars`, `timeout_ms` |
| `raw` | `bash_raw` | full output, no prune | `max_chars` (filesystem guard only), `timeout_ms` |

## Why

opencode's native `bash` tool has a fixed schema (`command`,
`description`, `timeoutMs`, ...). Plugin-only "bypass flags" like
`no_prune=true` or `disableForCalls=N` are documented in
`opencode-context-saver` plugin's disclosure — but they are silently
ignored by opencode because they are not part of the tool's schema.

This MCP server fixes that by exposing our **own** tools with **our**
schema. LLM can pick `bash_safe` (TUI adı; server-içi `safe`) or
`bash_raw` (TUI adı; server-içi `raw`) and the bypass actually works.

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
    "bash": {
      "type": "local",
      "command": ["node", "/root/opencode-plugins/dist/plugins/mcp-bash-tools/server.js"],
      "enabled": true
    }
  }
}
```

TUI'de kısa görünmesi için config key `bash` kullanın (eski uzun key
`opencode-mcp-bash-tools` de çalışır ama TUI'de
`opencode-mcp-bash-tools_bash_safe` gibi uzun adlara yol açar). Server
name (`bash` burada) `<server-name>_<tool-name>` TUI adlarını belirler
(`bash_safe`, `bash_raw`) — ve `opencode-context-saver` plugin'in
`skipTools` suffix kuralı bu adları key'den bağımsız yakalar.

## Marker format

When `bash_safe` (server-içi `safe`) prunes, output looks like:

```
[Run ls /tmp]
file1.txt
file2.txt
...

[... pruned: 60000→400 chars (99.3% saved). For raw output, call bash_raw with the same command. ...]

...last lines of file...
```

LLM sees this marker and knows the exact tool call to make for raw
output (schema-controlled, actually works).

## Plugin interaction

`opencode-context-saver` plugin (TASK-110) skips MCP tool names by
suffix rule (`bash_safe`, `bash_raw` match any `<key>_bash_safe` /
`<key>_bash_raw`) so the two layers don't double-prune — server key
renames can't silently break the skip.

## Platform

- POSIX: shell `/bin/bash` (TASK-115: dash orphan bırakır, bash şart).
- Windows (2026-09-08, ilk win32 canlı testi): `/bin/bash` ENOENT
  veriyordu, tüm komutlar `[exit 1]` dönüyordu. win32'de `ComSpec`
  (cmd) kullanılır — POSIX deyimleri çalışmaz (bilinçli sınır),
  orphan-garantisi TEST EDİLMEDİ.
