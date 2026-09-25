import test from "node:test"
import assert from "node:assert/strict"
import BuildHooksPlugin from "../dist/plugins/opencode-build-tracker.js"
import { setupV2, toolBefore, toolAfter, sessionContext, systemTexts, tick } from "./v2-harness.mjs"

function captureConsole() {
  const logs = []
  const origLog = console.log
  console.log = (...a) => logs.push(a.join(" "))
  return {
    logs,
    restore() { console.log = origLog },
  }
}

test("build-tracker: detects build command on tool.execute.before", async () => {
  const cap = captureConsole()
  try {
    const { toolHooks, store } = await setupV2(BuildHooksPlugin, { thresholdMs: 120000, verbose: true })
    await toolBefore(toolHooks, { id: "b1", input: { command: "npm run build" } })
    await toolAfter(toolHooks, { id: "b1", input: { command: "npm run build" }, output: "build succeeded" })
    assert.ok(cap.logs.some((l) => l.includes("onBuildSuccess")))
    const rec = store.get("nabiz:last-build")
    assert.ok(rec.message.includes("Build success"))
  } finally {
    cap.restore()
  }
})

test("build-tracker: non-build command does not start a session", async () => {
  const cap = captureConsole()
  try {
    const { toolHooks, store } = await setupV2(BuildHooksPlugin, {})
    await toolBefore(toolHooks, { id: "b2", input: { command: "echo hello" } })
    assert.ok(!cap.logs.some((l) => l.includes("onBuildStart")))
    const out = await toolAfter(toolHooks, { id: "b2", input: { command: "echo hello" }, output: "hello" })
    assert.equal(out, "hello")
    assert.equal(store.get("nabiz:last-build"), undefined)
  } finally {
    cap.restore()
  }
})

test("build-tracker: chained command (cd && npm run build) is detected", async () => {
  const cap = captureConsole()
  try {
    const { toolHooks } = await setupV2(BuildHooksPlugin, { verbose: true })
    await toolBefore(toolHooks, { id: "b3", input: { command: "cd web && npm run build" } })
    assert.ok(cap.logs.some((l) => l.includes("onBuildStart")))
  } finally {
    cap.restore()
  }
})

test("build-tracker: event command.executed starts a build session (V2 subscribe)", async () => {
  const cap = captureConsole()
  try {
    const { pushEvent, cleanup } = await setupV2(BuildHooksPlugin, { verbose: true })
    pushEvent({ type: "command.executed", command: "vite build" })
    await tick()
    assert.ok(cap.logs.some((l) => l.includes("onBuildStart")))
    await cleanup()
  } finally {
    cap.restore()
  }
})

test("build-tracker: false positive guard — comment with 'error' does NOT trigger failure", async () => {
  const cap = captureConsole()
  try {
    const { toolHooks, store } = await setupV2(BuildHooksPlugin, {})
    await toolBefore(toolHooks, { id: "fp1", input: { command: "npm run build" } })
    await toolAfter(toolHooks, {
      id: "fp1",
      input: { command: "npm run build" },
      output: "// TODO: handle error case here\nlet x = 1\nbuild ok",
    })
    assert.ok(!cap.logs.some((l) => l.includes("onBuildFailure")), "yorum satırı false positive")
    // Yorum satırı failure değil — build-call tamamlanınca session success kapanır.
    assert.ok(store.get("nabiz:last-build").message.includes("Build success"))
  } finally {
    cap.restore()
  }
})

test("build-tracker: false positive guard — help text with 'failed' does NOT trigger failure", async () => {
  const cap = captureConsole()
  try {
    const { toolHooks } = await setupV2(BuildHooksPlugin, {})
    await toolBefore(toolHooks, { id: "fp2", input: { command: "cargo build" } })
    await toolAfter(toolHooks, {
      id: "fp2",
      input: { command: "cargo build" },
      output: "Usage: cargo build [options]\n  --retry  Retry if previous run failed\nCompiled OK",
    })
    assert.ok(!cap.logs.some((l) => l.includes("onBuildFailure")), "help text false positive")
  } finally {
    cap.restore()
  }
})

test("build-tracker: real rustc error (anchor pattern) IS detected as failure", async () => {
  const cap = captureConsole()
  try {
    const { toolHooks } = await setupV2(BuildHooksPlugin, { verbose: true })
    await toolBefore(toolHooks, { id: "real1", input: { command: "cargo build" } })
    cap.logs.length = 0
    const errOut = "warning: unused variable\nerror[E0425]: cannot find value `x`\n  --> src/main.rs:5:9"
    await toolAfter(toolHooks, { id: "real1", input: { command: "cargo build" }, output: errOut })
    assert.ok(cap.logs.some((l) => l.includes("onBuildFailure")), "rustc error algılanmalı")
  } finally {
    cap.restore()
  }
})

test("build-tracker: success goes to storage (V2: ctx.storage replaces client.app.log)", async () => {
  const { toolHooks, store } = await setupV2(BuildHooksPlugin, {})
  await toolBefore(toolHooks, { id: "toast1", input: { command: "npm run build" } })
  await toolAfter(toolHooks, { id: "toast1", input: { command: "npm run build" }, output: "build succeeded" })
  const rec = store.get("nabiz:last-build")
  assert.ok(rec.message.includes("Build success"))
  assert.ok(rec.message.includes("npm run build"))
  assert.equal(rec.level, "info")
})

test("build-tracker: failure goes to storage with error level", async () => {
  const { toolHooks, store } = await setupV2(BuildHooksPlugin, {})
  await toolBefore(toolHooks, { id: "toast2", input: { command: "cargo build" } })
  await toolAfter(toolHooks, {
    id: "toast2",
    input: { command: "cargo build" },
    output: "error[E0425]: cannot find value `x`",
  })
  const rec = store.get("nabiz:last-build")
  assert.ok(rec.message.includes("Build failed"))
  assert.equal(rec.level, "error")
})

test("build-tracker: storage failure is tolerated (best-effort write)", async () => {
  const h = await setupV2(BuildHooksPlugin, {})
  h.ctx.storage.set = async () => { throw new Error("disk full") }
  await toolBefore(h.toolHooks, { id: "notoast1", input: { command: "npm run build" } })
  await toolAfter(h.toolHooks, { id: "notoast1", input: { command: "npm run build" }, output: "ok" })
  await h.cleanup()
})

test("build-tracker: default silent — no stdout, status still goes to storage (Termux ghost fix)", async () => {
  const cap = captureConsole()
  try {
    const { toolHooks, store } = await setupV2(BuildHooksPlugin, {})
    await toolBefore(toolHooks, { id: "silent1", input: { command: "npm run build" } })
    assert.equal(cap.logs.length, 0)
    await toolAfter(toolHooks, { id: "silent1", input: { command: "npm run build" }, output: "build succeeded" })
    assert.equal(cap.logs.length, 0)
    assert.ok(store.get("nabiz:last-build").message.includes("Build success"))
  } finally {
    cap.restore()
  }
})

test("build-tracker: extraErrorPatterns catches pytest FAILED (builtin gap)", async () => {
  const cap = captureConsole()
  try {
    // Not: session açmak için komut build sayılmalı (after-hook sess.active
    // yoksa erken döner); çıktı regex katmanını test eder.
    const cmd = "npm run build"
    const pytestOut = "FAILED test_x.py::test_bar - assert 1 == 2"
    // Önce kanıt: default listede pytest formatı yok → failure yok.
    const plain = await setupV2(BuildHooksPlugin, { verbose: true })
    await toolBefore(plain.toolHooks, { id: "py0", input: { command: cmd } })
    await toolAfter(plain.toolHooks, { id: "py0", input: { command: cmd }, output: pytestOut })
    assert.ok(!cap.logs.some((l) => l.includes("onBuildFailure")), "builtin misses pytest")
    await plain.cleanup()
    // Additive desenle yakalanır.
    const h = await setupV2(BuildHooksPlugin, { verbose: true, extraErrorPatterns: ["^FAILED\\s"] })
    await toolBefore(h.toolHooks, { id: "py1", input: { command: cmd } })
    await toolAfter(h.toolHooks, { id: "py1", input: { command: cmd }, output: pytestOut })
    assert.ok(cap.logs.some((l) => l.includes("onBuildFailure")), "extra pattern hits")
    await h.cleanup()
  } finally {
    cap.restore()
  }
})

test("build-tracker: extraErrorPatterns is additive, builtins retained", async () => {
  const cap = captureConsole()
  try {
    const h = await setupV2(BuildHooksPlugin, { verbose: true, extraErrorPatterns: ["^FAILED\\s"] })
    await toolBefore(h.toolHooks, { id: "ad1", input: { command: "npm run build" } })
    await toolAfter(h.toolHooks, { id: "ad1", input: { command: "npm run build" }, output: "npm ERR! boom" })
    assert.ok(cap.logs.some((l) => l.includes("onBuildFailure")), "builtin still active")
    await h.cleanup()
  } finally {
    cap.restore()
  }
})

test("build-tracker: invalid extraErrorPatterns throws at init (fail-loud)", async () => {
  await assert.rejects(
    setupV2(BuildHooksPlugin, { extraErrorPatterns: ["(["] }),
    /invalid extraErrorPatterns/,
  )
})

test("build-tracker: mini-disclosure once (sentinel idempotent, TASK-129)", async () => {
  const { sessionHooks } = await setupV2(BuildHooksPlugin, {})
  const e = await sessionContext(sessionHooks, [])
  const e2 = await sessionContext(sessionHooks, e.system)
  assert.equal(e2.system.length, 1)
  const texts = systemTexts(e2.system)
  assert.ok(texts[0].includes("[build-tracker]"), "sentinel")
  assert.ok(texts[0].includes("extraErrorPatterns"), "feature pointer")
  assert.ok(texts[0].includes("storage"), "log semantics")
  assert.equal(e2.system[0].type, "text")
})

test("build-tracker: array command (hbmon argv) opens a session (TASK-128)", async () => {
  const cap = captureConsole()
  try {
    const h = await setupV2(BuildHooksPlugin, { verbose: true })
    await toolBefore(h.toolHooks, {
      id: "arr1",
      tool: "hbmon_watch",
      input: { command: ["cargo", "build", "--release"] },
    })
    assert.ok(cap.logs.some((l) => l.includes("onBuildStart")), "argv session opens")
    assert.ok(cap.logs.some((l) => l.includes("cargo build --release")), "argv joined")
    await h.cleanup()
  } finally {
    cap.restore()
  }
})

test("build-tracker: pytest session + FAILED output + extra pattern = failure (TASK-128 e2e)", async () => {
  const cap = captureConsole()
  try {
    const h = await setupV2(BuildHooksPlugin, { verbose: true, extraErrorPatterns: ["^FAILED\\s"] })
    await toolBefore(h.toolHooks, { id: "pytest1", input: { command: "pytest tests/ -x" } })
    assert.ok(cap.logs.some((l) => l.includes("onBuildStart")), "pytest opens session")
    await toolAfter(h.toolHooks, {
      id: "pytest1",
      input: { command: "pytest tests/ -x" },
      output: "FAILED test_x.py::test_bar - assert",
    })
    assert.ok(cap.logs.some((l) => l.includes("onBuildFailure")), "failure detected")
    await h.cleanup()
  } finally {
    cap.restore()
  }
})

test("build-tracker: session.idle event closes an open build session", async () => {
  const { toolHooks, pushEvent, store, cleanup } = await setupV2(BuildHooksPlugin, {})
  await toolBefore(toolHooks, { id: "idle1", input: { command: "npm run build" } })
  pushEvent({ type: "session.idle" })
  await tick()
  assert.ok(store.get("nabiz:last-build").message.includes("Build success"))
  await cleanup()
})
