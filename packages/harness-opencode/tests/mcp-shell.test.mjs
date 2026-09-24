/**
 * Regression test: MCP exec shell platform seçimi.
 *
 * 2026-09-08 win32 canlı testi: `shell: "/bin/bash"` Windows'ta ENOENT
 * veriyor, `echo` bile `[exit 1]` dönüyordu. ComSpec fallback sonrası
 * `echo` her platformda exit 0 dönmeli.
 *
 * Testler dist/ çıktısını import eder (pretest build).
 */

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"

const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url))
const ROOT = dirname(TESTS_DIR)
const { runBash } = await import(
  pathToFileURL(join(ROOT, "dist", "plugins", "mcp-bash-tools", "src", "exec.js")).href
)

test("runBash echo: exit 0 + stdout (platform shell)", async () => {
  const r = await runBash("echo mcp-shell-ok", 15000)
  assert.equal(r.exitCode, 0)
  assert.ok(r.stdout.includes("mcp-shell-ok"), `stdout: ${JSON.stringify(r.stdout)}`)
})

test("runBash hatalı komut: exit != 0, crash yok", async () => {
  const r = await runBash("exit 3", 15000)
  assert.notEqual(r.exitCode, 0)
})
