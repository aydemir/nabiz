import test from "node:test"
import assert from "node:assert/strict"
import {
  PRUNE_MARKER,
  codePointLength,
  pruneMiddle,
  extractSummarySafe,
  isBuildCommand,
  extractErrors,
  formatPruneMarker,
  formatShortPruneMarker,
  matchesRawPatterns,
  matchesSkipTools,
  resolvePruneBudget,
} from "nabiz-core/prune"

test("codePointLength counts code points, not UTF-16 units", () => {
  assert.equal(codePointLength("hello"), 5)
  assert.equal(codePointLength("👍"), 1)
  assert.equal(codePointLength("a👍b"), 3)
})

test("pruneMiddle: large text kept shape is head+marker+tail", () => {
  const big = "A".repeat(250) + "B".repeat(500) + "C".repeat(250)
  const out = pruneMiddle(big, { headChars: 100, tailChars: 50 })
  assert.ok(out.includes(PRUNE_MARKER.trim()))
  assert.ok(out.startsWith("A".repeat(100)))
  assert.ok(out.endsWith("C".repeat(50)))
  assert.ok(codePointLength(out) < codePointLength(big))
  assert.equal(codePointLength(out), 100 + codePointLength(PRUNE_MARKER) + 50)
})

test("pruneMiddle: small text passes through unchanged", () => {
  const small = "hello"
  assert.equal(pruneMiddle(small, { headChars: 100, tailChars: 50 }), small)
})

test("pruneMiddle: second pass on already-pruned input throws (fail-fast guard)", () => {
  // Eski test "idempotent" yazıyordu; gerçek davranışta pruneMiddle
  // ikinci geçişte resultLen === points.length olacağını görünce throw
  // eder (no-op prune'u sessizce kabul etmek yerine). Bu bilinçli
  // fail-fast — sessiz no-op call-site'ları maskeler. Davranış değişirse
  // bu test güncellenmeli.
  const big = "X".repeat(1000)
  const once = pruneMiddle(big, { headChars: 100, tailChars: 50 })
  assert.throws(
    () => pruneMiddle(once, { headChars: 100, tailChars: 50 }),
    /replacement.*must be < input/,
  )
})

test("resolvePruneBudget: valid head+marker+tail under threshold is OK", () => {
  resolvePruneBudget({ compressThreshold: 500, headChars: 100, tailChars: 50 })
})

test("resolvePruneBudget: invalid budget throws", () => {
  assert.throws(() =>
    resolvePruneBudget({ compressThreshold: 100, headChars: 100, tailChars: 50 }),
  )
})

test("isBuildCommand: tokens + phrases + chained segments", () => {
  assert.equal(isBuildCommand("npm run build"), true)
  assert.equal(isBuildCommand("cargo build"), true)
  assert.equal(isBuildCommand("tsc --noEmit"), true)
  assert.equal(isBuildCommand("vite build"), true)
  assert.equal(isBuildCommand("docker build -t foo ."), true)
  assert.equal(isBuildCommand("cd web && npm run build"), true)
  assert.equal(isBuildCommand("ls -la"), false)
  assert.equal(isBuildCommand("echo hello"), false)
  assert.equal(isBuildCommand("rain run something"), true)
  assert.equal(isBuildCommand("pip install requests"), true)
  assert.equal(isBuildCommand("training model"), false)
})

test("isBuildCommand: case-insensitive first token", () => {
  assert.equal(isBuildCommand("NPM RUN BUILD"), true)
})

test("extractErrors: captures error lines + last-tail always kept", () => {
  const out = [
    "line1",
    "error: something failed",
    "line3",
    "TypeError: x is not defined",
    "line5",
    "line6 tail",
  ].join("\n")
  const errs = extractErrors(out, { maxLines: 15, tailLines: 5 })
  assert.ok(errs.some((l) => l.includes("error: something failed")))
  assert.ok(errs.some((l) => l.includes("TypeError")))
  assert.ok(errs.includes("line6 tail"))
})

test("extractSummarySafe: truncates per-key values", () => {
  const s = extractSummarySafe(
    "bash",
    { command: "a".repeat(100), extra: "b".repeat(100) },
    { maxCharsPerKey: 10, maxSummaryChars: 200 },
  )
  assert.ok(s.includes("bash("))
  assert.ok(s.includes("…"))
})

test("extractSummarySafe: missing args returns empty parts", () => {
  const s = extractSummarySafe("read", null)
  assert.equal(s, "read(, )")
})

test("formatPruneMarker: default hint declares both no_prune and off paths", () => {
  const m = formatPruneMarker({ originalChars: 1000, keptChars: 150 })
  assert.ok(m.includes("pruned:"))
  assert.ok(m.includes("no_prune=true"))
  assert.ok(m.includes("enabled:false"))
  assert.ok(m.includes("off"))
})

test("formatPruneMarker: custom escapeHint is preserved", () => {
  const m = formatPruneMarker({ originalChars: 1000, keptChars: 150, escapeHint: "custom-hint" })
  assert.ok(m.includes("custom-hint"))
  assert.ok(!m.includes("no_prune=true"))
})

test("formatShortPruneMarker: short marker lists 5 escape ways, drops long prose", () => {
  const long = formatPruneMarker({ originalChars: 1000, keptChars: 150 })
  const short = formatShortPruneMarker({ originalChars: 1000, keptChars: 150 })
  assert.ok(short.includes("pruned:"))
  assert.ok(short.includes("enabled:false"))
  // TASK-108: kısa marker artık 5 yolu içerir, dolayısıyla uzun marker'dan
  // uzun olabilir. Invariant: "For raw output:" (uzun marker'a özgü) kısa
  // marker'da yok.
  assert.ok(!short.includes("For raw output:"))
  assert.ok(long.includes("For raw output:"))
})

test("pruneMiddle: second pass on short-marked input stays marked", () => {
  // Dinamik marker'da sayı kısalınca sonuç küçülebilir (throw şart değil);
  // invariant: çıktı işaretsiz hale gelmez, "pruned:" korunur.
  const big = "x".repeat(2000)
  const once = pruneMiddle(big, { headChars: 100, tailChars: 50, markerBuilder: formatShortPruneMarker })
  let twice
  try {
    twice = pruneMiddle(once, { headChars: 100, tailChars: 50, markerBuilder: formatShortPruneMarker })
  } catch {
    twice = once
  }
  assert.ok(twice.includes("pruned:"))
})

test("matchesRawPatterns: substring hit/miss, empty patterns", () => {
  assert.equal(matchesRawPatterns({ command: "npm test" }, []), false)
  assert.equal(matchesRawPatterns({ command: "npm test" }, ["npm test"]), true)
  assert.equal(matchesRawPatterns({ command: "npm test" }, ["vite"]), false)
  assert.equal(matchesRawPatterns({}, ["npm"]), false)
})

test("matchesRawPatterns: regex: prefix and nested values", () => {
  assert.equal(matchesRawPatterns({ command: "ls -R /tmp" }, ["regex:^ls"]), true)
  assert.equal(matchesRawPatterns({ command: "echo hi" }, ["regex:^ls"]), false)
  assert.equal(matchesRawPatterns({ nested: { cmd: "npm run build" } }, ["npm run"]), true)
})

test("matchesRawPatterns: invalid regex throws (fail loud)", () => {
  assert.throws(() => matchesRawPatterns({ command: "x" }, ["regex:(["]))
})

test("formatShortPruneMarker: lists all 5 escape ways with default skipWhenContains", () => {
  const out = formatShortPruneMarker({ originalChars: 50000, keptChars: 300 })
  assert.match(out, /no_prune\/noPrune\/skipPrune/)
  assert.match(out, /#no-prune/)
  assert.match(out, /disableForCalls/)
  assert.match(out, /alwaysRawCommands/)
  assert.match(out, /enabled:false/)
})

test("formatShortPruneMarker: respects custom skipWhenContains", () => {
  const out = formatShortPruneMarker(
    { originalChars: 1000, keptChars: 200 },
    { skipWhenContains: "%%raw%%" },
  )
  assert.match(out, /%%raw%%/)
  assert.doesNotMatch(out, /#no-prune/)
})

test("formatShortPruneMarker: backwards-compatible when called with only stats", () => {
  const out = formatShortPruneMarker({ originalChars: 100, keptChars: 50 })
  assert.match(out, /Raw ways:/)
  assert.match(out, /#no-prune/)
})

test("matchesSkipTools: exact match (native tools)", () => {
  assert.equal(matchesSkipTools("read", ["read", "bash_safe"]), true)
  assert.equal(matchesSkipTools("Read", ["read", "Read"]), true)
  assert.equal(matchesSkipTools("bash", ["read", "bash_safe"]), false)
})

test("matchesSkipTools: _suffix match survives MCP server key renames", () => {
  const list = ["bash_safe", "bash_raw"]
  assert.equal(matchesSkipTools("bash_safe", list), true)
  assert.equal(matchesSkipTools("bash_raw", list), true)
  assert.equal(matchesSkipTools("opencode-mcp-bash-tools_bash_safe", list), true)
  assert.equal(matchesSkipTools("opencode-mcp-bash-tools_bash_raw", list), true)
  assert.equal(matchesSkipTools("futurekey_bash_safe", list), true)
})

test("matchesSkipTools: underscore boundary prevents false positives", () => {
  // "bread" ends with "read" but not "_read" — must NOT match.
  assert.equal(matchesSkipTools("bread", ["read"]), false)
  assert.equal(matchesSkipTools("thread", ["read"]), false)
  assert.equal(matchesSkipTools("notbash_safe", ["bash_safe"]), false)
  assert.equal(matchesSkipTools("xread", ["read"]), false)
})

test("matchesSkipTools: case-sensitive, empty entries ignored", () => {
  assert.equal(matchesSkipTools("READ", ["read"]), false)
  assert.equal(matchesSkipTools("read", [""]), false)
  assert.equal(matchesSkipTools("read", []), false)
})

test("isBuildCommand: test runners open sessions (TASK-128)", () => {
  assert.equal(isBuildCommand("pytest"), true)
  assert.equal(isBuildCommand("pytest tests/ -x"), true)
  assert.equal(isBuildCommand("python -m pytest tests/"), true)
  assert.equal(isBuildCommand("npx jest"), true)
  assert.equal(isBuildCommand("npx vitest run"), true)
  assert.equal(isBuildCommand("jest src/"), true)
})

test("isBuildCommand: bare interpreters stay quiet (noise guard, TASK-128)", () => {
  assert.equal(isBuildCommand("python script.py"), false)
  assert.equal(isBuildCommand("node server.js"), false)
  assert.equal(isBuildCommand("npx eslint ."), false)
  assert.equal(isBuildCommand("python3 -c \"print(1)\""), false)
})
