import test from "node:test"
import assert from "node:assert/strict"
import { codePointLength } from "nabiz-core/prune"
import ToolCompactPlugin from "../dist/plugins/opencode-context-saver.js"
import { setupV2, toolBefore, toolAfter, sessionContext, sessionPrompt, systemTexts } from "./v2-harness.mjs"

test("context-saver: small output is left untouched", async () => {
  const { toolHooks } = await setupV2(ToolCompactPlugin, {})
  await toolBefore(toolHooks, { id: "1", input: { command: "echo hi" } })
  const out = await toolAfter(toolHooks, { id: "1", input: { command: "echo hi" }, output: "hi" })
  assert.equal(out, "hi")
})

test("context-saver: large output is pruned with summary header and shorter than input", async () => {
  const { toolHooks } = await setupV2(ToolCompactPlugin, {})
  const big = "A".repeat(300) + "B".repeat(300) + "C".repeat(300)
  await toolBefore(toolHooks, { id: "2", input: { command: "cat bigfile" } })
  const out = await toolAfter(toolHooks, { id: "2", input: { command: "cat bigfile" }, output: big })
  // context-saver kendi formatPruneMarker'ını kullanıyor (bilgilendirici
  // marker, sabit PRUNE_MARKER değil). Marker'ı formatında "pruned:" ile
  // arıyoruz — bu kullanıcıya gösterilen nihai biçim.
  assert.ok(out.includes("pruned:"))
  assert.ok(out.startsWith("[bash("))
  assert.ok(codePointLength(out) < big.length)
})

test("context-saver: error output is replaced with warning + extracted errors", async () => {
  const { toolHooks } = await setupV2(ToolCompactPlugin, {})
  const errOut = "line1\nerror: build failed\nTypeError: x\nline tail"
  await toolBefore(toolHooks, { id: "3", input: { command: "npm run build" } })
  const out = await toolAfter(toolHooks, { id: "3", input: { command: "npm run build" }, output: errOut })
  assert.ok(out.startsWith("⚠️"))
  assert.ok(out.includes("error: build failed"))
})

test("context-saver: non-string output goes through JSON.stringify", async () => {
  const { toolHooks } = await setupV2(ToolCompactPlugin, {})
  await toolBefore(toolHooks, { id: "4", tool: "read", input: { filePath: "/foo" } })
  const out = await toolAfter(toolHooks, {
    id: "4",
    tool: "read",
    input: { filePath: "/foo" },
    output: { key: "value", nested: { a: 1 } },
  })
  assert.ok(out !== null)
})

test("context-saver: prompt hook stays silent, never writes to TUI", async () => {
  const { toolHooks, sessionHooks } = await setupV2(ToolCompactPlugin, {})
  await toolBefore(toolHooks, { id: "5", input: { command: "echo hi" } })
  await toolAfter(toolHooks, { id: "5", input: { command: "echo hi" }, output: "hi" })
  // V1 `chat.message` → V2 `session.hook("prompt")`: sayaç sıfırlanır, çıktı yok.
  const e = await sessionPrompt(sessionHooks, "hi")
  assert.equal(e.delivery, "steer")
})

test("context-saver: skipTools — read tool long output not pruned", async () => {
  const { toolHooks } = await setupV2(ToolCompactPlugin, {})
  const big = "a".repeat(600)
  await toolBefore(toolHooks, { id: "10", tool: "read", input: {} })
  const out = await toolAfter(toolHooks, { id: "10", tool: "read", input: {}, output: big })
  // read is in default skipTools, so no prune: raw output preserved, no marker
  assert.equal(out, big)
  assert.ok(!out.includes("pruned"))
})

test("context-saver: skipTools — bash long output is pruned", async () => {
  const { toolHooks } = await setupV2(ToolCompactPlugin, {})
  const big = "a".repeat(600)
  await toolBefore(toolHooks, { id: "11", input: {} })
  const out = await toolAfter(toolHooks, { id: "11", input: {}, output: big })
  // bash not in skipTools, so prune should apply
  assert.ok(out.length < big.length)
  assert.ok(out.includes("pruned"))
})

test("context-saver: skipTools — MCP bash tools not double-pruned (new + legacy names)", async () => {
  const { toolHooks } = await setupV2(ToolCompactPlugin, {})
  const big = "a".repeat(600)
  // Yeni TUI adları (config key `bash` + server-içi `safe`/`raw`).
  for (const tool of ["nabiz_safe", "nabiz_raw"]) {
    await toolBefore(toolHooks, { id: `mcp-${tool}`, tool, input: {} })
    const out = await toolAfter(toolHooks, { id: `mcp-${tool}`, tool, input: {}, output: big })
    assert.equal(out, big, tool)
  }
  // Eski uzun adlar suffix kuralıyla hâlâ atlanır (listede ayrıca yok).
  for (const tool of ["opencode-mcp-bash-tools_nabiz_safe", "opencode-mcp-bash-tools_nabiz_raw"]) {
    await toolBefore(toolHooks, { id: `mcp-${tool}`, tool, input: {} })
    const out = await toolAfter(toolHooks, { id: `mcp-${tool}`, tool, input: {}, output: big })
    assert.equal(out, big, tool)
  }
  // Gelecekteki key rename'leri de suffix kuralıyla kapsanır.
  await toolBefore(toolHooks, { id: "mcp-future", tool: "somefuturekey_nabiz_raw", input: {} })
  const out = await toolAfter(toolHooks, {
    id: "mcp-future",
    tool: "somefuturekey_nabiz_raw",
    input: {},
    output: big,
  })
  assert.equal(out, big)
})

test("context-saver: skipTools — user list merges with defaults (no silent loss)", async () => {
  const { toolHooks } = await setupV2(ToolCompactPlugin, { skipTools: ["mytool"] })
  const big = "a".repeat(600)
  // Kullanıcının girdisi çalışır...
  for (const tool of ["mytool"]) {
    await toolBefore(toolHooks, { id: `u-${tool}`, tool, input: {} })
    const out = await toolAfter(toolHooks, { id: `u-${tool}`, tool, input: {}, output: big })
    assert.equal(out, big, tool)
  }
  // ...ve default korumalar (read + MCP) hâlâ durur.
  for (const tool of ["read", "nabiz_safe", "opencode-mcp-bash-tools_nabiz_raw"]) {
    await toolBefore(toolHooks, { id: `u-${tool}`, tool, input: {} })
    const out = await toolAfter(toolHooks, { id: `u-${tool}`, tool, input: {}, output: big })
    assert.equal(out, big, tool)
  }
})

test("context-saver: first prune in session uses long marker, second uses short", async () => {
  const { toolHooks } = await setupV2(ToolCompactPlugin, {})
  const big = "y".repeat(5000)
  await toolBefore(toolHooks, { id: "20", sessionID: "sess-1", input: { command: "echo big" } })
  const out1 = await toolAfter(toolHooks, {
    id: "20",
    sessionID: "sess-1",
    input: { command: "echo big" },
    output: big,
  })
  assert.ok(out1.includes("For raw output:"))
  assert.ok(out1.includes("enabled:false"))
  await toolBefore(toolHooks, { id: "21", sessionID: "sess-1", input: { command: "echo big2" } })
  const out2 = await toolAfter(toolHooks, {
    id: "21",
    sessionID: "sess-1",
    input: { command: "echo big2" },
    output: big,
  })
  assert.ok(out2.includes("pruned:"))
  assert.ok(!out2.includes("For raw output:"))
})

test("context-saver: new session gets long marker again", async () => {
  const { toolHooks } = await setupV2(ToolCompactPlugin, {})
  const big = "y".repeat(5000)
  for (const sid of ["sess-a", "sess-b"]) {
    await toolBefore(toolHooks, { id: sid, sessionID: sid, input: { command: "echo big" } })
    const out = await toolAfter(toolHooks, {
      id: sid,
      sessionID: sid,
      input: { command: "echo big" },
      output: big,
    })
    assert.ok(out.includes("For raw output:"), sid)
  }
})

test("context-saver: session context hook injects disclosure once (V2 SystemPart)", async () => {
  const { sessionHooks } = await setupV2(ToolCompactPlugin, {})
  const e = await sessionContext(sessionHooks, [{ type: "text", text: "base prompt" }])
  const e2 = await sessionContext(sessionHooks, e.system)
  const texts = systemTexts(e2.system)
  assert.equal(e2.system.length, 2)
  assert.ok(texts[1].includes("[context-saver]"))
  // MCP-era disclosure (KD-2026-09-05-mcp-bypass): bypass yolu nabiz_safe/nabiz_raw.
  // 2026-09-10 düzeltme: "NOT honored" iddiası YANLIŞTI — shouldSkipForArgs
  // args içindeki skipWhenContains'i honor ediyor. Disclosure artık doğru
  // kapsamı söyler: native bash prune, read/grep/glob asla prune değil.
  assert.ok(texts[1].includes("nabiz_safe"))
  assert.ok(texts[1].includes("nabiz_raw"))
  assert.ok(texts[1].includes("#no-prune"))
  assert.ok(texts[1].includes("NEVER pruned"))
  // V2 SystemPart şekli: { type: "text", text }.
  assert.equal(e2.system[1].type, "text")
})

test("context-saver: context hook skips when disclosure already present", async () => {
  const { sessionHooks } = await setupV2(ToolCompactPlugin, {})
  const e = await sessionContext(sessionHooks, ["[context-saver] already disclosed"])
  assert.equal(e.system.length, 1)
})

test("context-saver: discloseOnce:false disables system injection", async () => {
  const { sessionHooks } = await setupV2(ToolCompactPlugin, { discloseOnce: false })
  const e = await sessionContext(sessionHooks, [])
  assert.equal(e.system.length, 0)
})

test("context-saver: alwaysRawCommands bypasses prune on match", async () => {
  const { toolHooks } = await setupV2(ToolCompactPlugin, { alwaysRawCommands: ["npm test"] })
  const big = "z".repeat(5000)
  await toolBefore(toolHooks, { id: "30", sessionID: "w-1", input: { command: "npm test 2>&1" } })
  const out1 = await toolAfter(toolHooks, {
    id: "30",
    sessionID: "w-1",
    input: { command: "npm test 2>&1" },
    output: big,
  })
  assert.equal(out1, big)
  await toolBefore(toolHooks, { id: "31", sessionID: "w-1", input: { command: "echo other" } })
  const out2 = await toolAfter(toolHooks, {
    id: "31",
    sessionID: "w-1",
    input: { command: "echo other" },
    output: big,
  })
  assert.ok(out2.includes("pruned:"))
})

test("context-saver: disableForCalls gives N raw calls then resumes prune", async () => {
  const { toolHooks } = await setupV2(ToolCompactPlugin, { disableForCalls: 2 })
  const big = "z".repeat(5000)
  const cases = [["40", true], ["41", true], ["42", false]]
  for (const [id, raw] of cases) {
    await toolBefore(toolHooks, { id, sessionID: "c-1", input: { command: "echo x" } })
    const out = await toolAfter(toolHooks, {
      id,
      sessionID: "c-1",
      input: { command: "echo x" },
      output: big,
    })
    if (raw) assert.equal(out, big, id)
    else assert.ok(out.includes("pruned:"), id)
  }
})

test("context-saver: per-call disableForCalls refills counter", async () => {
  const { toolHooks } = await setupV2(ToolCompactPlugin, {})
  const big = "z".repeat(5000)
  await toolBefore(toolHooks, {
    id: "50",
    sessionID: "r-1",
    input: { command: "echo x", disableForCalls: 1 },
  })
  const out1 = await toolAfter(toolHooks, {
    id: "50",
    sessionID: "r-1",
    input: { command: "echo x", disableForCalls: 1 },
    output: big,
  })
  assert.equal(out1, big)
  await toolBefore(toolHooks, { id: "51", sessionID: "r-1", input: { command: "echo x" } })
  const out2 = await toolAfter(toolHooks, {
    id: "51",
    sessionID: "r-1",
    input: { command: "echo x" },
    output: big,
  })
  assert.ok(out2.includes("pruned:"))
})

test("context-saver: invalid alwaysRawCommands regex rejects at init", async () => {
  await assert.rejects(setupV2(ToolCompactPlugin, { alwaysRawCommands: ["regex:(["] }))
})

test("context-saver: negative disableForCalls rejects at init", async () => {
  await assert.rejects(setupV2(ToolCompactPlugin, { disableForCalls: -1 }))
})
