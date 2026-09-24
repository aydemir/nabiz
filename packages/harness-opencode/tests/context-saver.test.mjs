import test from "node:test"
import assert from "node:assert/strict"
import { codePointLength } from "nabiz-core/prune"
import ToolCompactPlugin from "../dist/plugins/opencode-context-saver.js"

const fakeClient = () => ({
  tui: { showToast: async () => {} },
  app: { log: async () => {} },
})

test("context-saver: small output is left untouched", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, {})
  const t = { callID: "1", tool: "bash", args: { command: "echo hi" } }
  await plugin["tool.execute.before"](t)
  const output = { output: "hi" }
  await plugin["tool.execute.after"](t, output)
  assert.equal(output.output, "hi")
})

test("context-saver: large output is pruned with summary header and shorter than input", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, {})
  const big = "A".repeat(300) + "B".repeat(300) + "C".repeat(300)
  const t = { callID: "2", tool: "bash", args: { command: "cat bigfile" } }
  await plugin["tool.execute.before"](t)
  const output = { output: big }
  await plugin["tool.execute.after"](t, output)
  // context-saver kendi formatPruneMarker'ını kullanıyor (bilgilendirici
  // marker, sabit PRUNE_MARKER değil). Marker'ı formatında "pruned:" ile
  // arıyoruz — bu kullanıcıya gösterilen nihai biçim.
  assert.ok(output.output.includes("pruned:"))
  assert.ok(output.output.startsWith("[bash("))
  assert.ok(codePointLength(output.output) < big.length)
})

test("context-saver: error output is replaced with warning + extracted errors", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, {})
  const errOut = "line1\nerror: build failed\nTypeError: x\nline tail"
  const t = { callID: "3", tool: "bash", args: { command: "npm run build" } }
  await plugin["tool.execute.before"](t)
  const output = { output: errOut }
  await plugin["tool.execute.after"](t, output)
  assert.ok(output.output.startsWith("⚠️"))
  assert.ok(output.output.includes("error: build failed"))
})

test("context-saver: non-string output goes through JSON.stringify", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, {})
  const t = { callID: "4", tool: "read", args: { filePath: "/foo" } }
  await plugin["tool.execute.before"](t)
  const output = { output: { key: "value", nested: { a: 1 } } }
  await plugin["tool.execute.after"](t, output)
  assert.ok(output.output !== null)
})

test("context-saver: chat.message stays silent, never via toast or app.log (app.log leaves ghost text in TUI)", async () => {
  let toastCalls = 0
  let logged = null
  const cx = {
    tui: { showToast: async () => { toastCalls++ } },
    app: { log: async (entry) => { logged = entry } },
  }
  const plugin = await ToolCompactPlugin({ client: cx }, {})
  const t = { callID: "5", tool: "bash", args: { command: "echo hi" } }
  await plugin["tool.execute.before"](t)
  await plugin["tool.execute.after"](t, { output: "hi" })
  await plugin["chat.message"]({}, {})
  assert.equal(toastCalls, 0)
  assert.equal(logged, null)
})

test("context-saver: skipTools — read tool long output not pruned", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, {})
  const big = "a".repeat(600)
  const t = { callID: "10", tool: "read", args: {} }
  await plugin["tool.execute.before"](t)
  const output = { output: big }
  await plugin["tool.execute.after"](t, output)
  // read is in default skipTools, so no prune: raw output preserved, no marker
  assert.equal(output.output, big)
  assert.ok(!output.output.includes("pruned"))
})

test("context-saver: skipTools — bash long output is pruned", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, {})
  const big = "a".repeat(600)
  const t = { callID: "11", tool: "bash", args: {} }
  await plugin["tool.execute.before"](t)
  const output = { output: big }
  await plugin["tool.execute.after"](t, output)
  // bash not in skipTools, so prune should apply
  assert.ok(output.output.length < big.length)
  assert.ok(output.output.includes("pruned"))
})

test("context-saver: skipTools — MCP bash tools not double-pruned (new + legacy names)", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, {})
  const big = "a".repeat(600)
  // Yeni TUI adları (config key `bash` + server-içi `safe`/`raw`).
  for (const tool of ["bash_safe", "bash_raw"]) {
    const t = { callID: `mcp-${tool}`, tool, args: {} }
    await plugin["tool.execute.before"](t)
    const output = { output: big }
    await plugin["tool.execute.after"](t, output)
    assert.equal(output.output, big, tool)
  }
  // Eski uzun adlar suffix kuralıyla hâlâ atlanır (listede ayrıca yok).
  for (const tool of ["opencode-mcp-bash-tools_bash_safe", "opencode-mcp-bash-tools_bash_raw"]) {
    const t = { callID: `mcp-${tool}`, tool, args: {} }
    await plugin["tool.execute.before"](t)
    const output = { output: big }
    await plugin["tool.execute.after"](t, output)
    assert.equal(output.output, big, tool)
  }
  // Gelecekteki key rename'leri de suffix kuralıyla kapsanır.
  const t = { callID: "mcp-future", tool: "somefuturekey_bash_raw", args: {} }
  await plugin["tool.execute.before"](t)
  const output = { output: big }
  await plugin["tool.execute.after"](t, output)
  assert.equal(output.output, big)
})

test("context-saver: skipTools — user list merges with defaults (no silent loss)", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, { skipTools: ["mytool"] })
  const big = "a".repeat(600)
  // Kullanıcının girdisi çalışır...
  for (const tool of ["mytool"]) {
    const t = { callID: `u-${tool}`, tool, args: {} }
    await plugin["tool.execute.before"](t)
    const output = { output: big }
    await plugin["tool.execute.after"](t, output)
    assert.equal(output.output, big, tool)
  }
  // ...ve default korumalar (read + MCP) hâlâ durur.
  for (const tool of ["read", "bash_safe", "opencode-mcp-bash-tools_bash_raw"]) {
    const t = { callID: `u-${tool}`, tool, args: {} }
    await plugin["tool.execute.before"](t)
    const output = { output: big }
    await plugin["tool.execute.after"](t, output)
    assert.equal(output.output, big, tool)
  }
})

test("context-saver: first prune in session uses long marker, second uses short", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, {})
  const big = "y".repeat(5000)
  const t1 = { callID: "20", sessionID: "sess-1", tool: "bash", args: { command: "echo big" } }
  await plugin["tool.execute.before"](t1)
  const out1 = { output: big }
  await plugin["tool.execute.after"](t1, out1)
  assert.ok(out1.output.includes("For raw output:"))
  assert.ok(out1.output.includes("enabled:false"))
  const t2 = { callID: "21", sessionID: "sess-1", tool: "bash", args: { command: "echo big2" } }
  await plugin["tool.execute.before"](t2)
  const out2 = { output: big }
  await plugin["tool.execute.after"](t2, out2)
  assert.ok(out2.output.includes("pruned:"))
  assert.ok(!out2.output.includes("For raw output:"))
})

test("context-saver: new session gets long marker again", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, {})
  const big = "y".repeat(5000)
  for (const sid of ["sess-a", "sess-b"]) {
    const t = { callID: sid, sessionID: sid, tool: "bash", args: { command: "echo big" } }
    await plugin["tool.execute.before"](t)
    const out = { output: big }
    await plugin["tool.execute.after"](t, out)
    assert.ok(out.output.includes("For raw output:"), sid)
  }
})

test("context-saver: system.transform injects disclosure once", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, {})
  const output = { system: ["base prompt"] }
  await plugin["experimental.chat.system.transform"]({}, output)
  await plugin["experimental.chat.system.transform"]({}, output)
  assert.equal(output.system.length, 2)
  assert.ok(output.system[1].includes("[context-saver]"))
  // MCP-era disclosure (KD-2026-09-05-mcp-bypass): bypass yolu bash_safe/bash_raw.
  // 2026-09-10 düzeltme: "NOT honored" iddiası YANLIŞTI — shouldSkipForArgs
  // args içindeki skipWhenContains'i honor ediyor. Disclosure artık doğru
  // kapsamı söyler: native bash prune, read/grep/glob asla prune değil.
  assert.ok(output.system[1].includes("bash_safe"))
  assert.ok(output.system[1].includes("bash_raw"))
  assert.ok(output.system[1].includes("#no-prune"))
  assert.ok(output.system[1].includes("NEVER pruned"))
})

test("context-saver: system.transform skips when disclosure already present", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, {})
  const output = { system: ["[context-saver] already disclosed"] }
  await plugin["experimental.chat.system.transform"]({}, output)
  assert.equal(output.system.length, 1)
})

test("context-saver: discloseOnce:false disables system injection", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, { discloseOnce: false })
  const output = { system: [] }
  await plugin["experimental.chat.system.transform"]({}, output)
  assert.equal(output.system.length, 0)
})

test("context-saver: alwaysRawCommands bypasses prune on match", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, { alwaysRawCommands: ["npm test"] })
  const big = "z".repeat(5000)
  const t1 = { callID: "30", sessionID: "w-1", tool: "bash", args: { command: "npm test 2>&1" } }
  await plugin["tool.execute.before"](t1)
  const out1 = { output: big }
  await plugin["tool.execute.after"](t1, out1)
  assert.equal(out1.output, big)
  const t2 = { callID: "31", sessionID: "w-1", tool: "bash", args: { command: "echo other" } }
  await plugin["tool.execute.before"](t2)
  const out2 = { output: big }
  await plugin["tool.execute.after"](t2, out2)
  assert.ok(out2.output.includes("pruned:"))
})

test("context-saver: disableForCalls gives N raw calls then resumes prune", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, { disableForCalls: 2 })
  const big = "z".repeat(5000)
  const cases = [["40", true], ["41", true], ["42", false]]
  for (const [id, raw] of cases) {
    const t = { callID: id, sessionID: "c-1", tool: "bash", args: { command: "echo x" } }
    await plugin["tool.execute.before"](t)
    const out = { output: big }
    await plugin["tool.execute.after"](t, out)
    if (raw) assert.equal(out.output, big, id)
    else assert.ok(out.output.includes("pruned:"), id)
  }
})

test("context-saver: per-call disableForCalls refills counter", async () => {
  const plugin = await ToolCompactPlugin({ client: fakeClient() }, {})
  const big = "z".repeat(5000)
  const t1 = { callID: "50", sessionID: "r-1", tool: "bash", args: { command: "echo x", disableForCalls: 1 } }
  await plugin["tool.execute.before"](t1)
  const out1 = { output: big }
  await plugin["tool.execute.after"](t1, out1)
  assert.equal(out1.output, big)
  const t2 = { callID: "51", sessionID: "r-1", tool: "bash", args: { command: "echo x" } }
  await plugin["tool.execute.before"](t2)
  const out2 = { output: big }
  await plugin["tool.execute.after"](t2, out2)
  assert.ok(out2.output.includes("pruned:"))
})

test("context-saver: invalid alwaysRawCommands regex rejects at init", async () => {
  await assert.rejects(ToolCompactPlugin({ client: fakeClient() }, { alwaysRawCommands: ["regex:(["] }))
})

test("context-saver: negative disableForCalls rejects at init", async () => {
  await assert.rejects(ToolCompactPlugin({ client: fakeClient() }, { disableForCalls: -1 }))
})

