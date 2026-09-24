import test from "node:test"
import assert from "node:assert/strict"
import BuildHooksPlugin from "../dist/plugins/opencode-build-tracker.js"

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
    const fakeClient = { app: { log: async () => {} } }
    const plugin = await BuildHooksPlugin({ client: fakeClient }, { thresholdMs: 120000, verbose: true })
    const t = { callID: "b1", tool: "bash", args: { command: "npm run build" } }
    await plugin["tool.execute.before"](t, { args: t.args })
    await plugin["tool.execute.after"](t, { output: "build succeeded" })
    assert.ok(cap.logs.some((l) => l.includes("onBuildSuccess")))
  } finally {
    cap.restore()
  }
})

test("build-tracker: non-build command does not start a session", async () => {
  const cap = captureConsole()
  try {
    const fakeClient = { app: { log: async () => {} } }
    const plugin = await BuildHooksPlugin({ client: fakeClient }, {})
    const t = { callID: "b2", tool: "bash", args: { command: "echo hello" } }
    await plugin["tool.execute.before"](t, { args: t.args })
    assert.ok(!cap.logs.some((l) => l.includes("onBuildStart")))
    const out = { output: "hello" }
    await plugin["tool.execute.after"](t, out)
    assert.equal(out.metadata, undefined)
  } finally {
    cap.restore()
  }
})

test("build-tracker: chained command (cd && npm run build) is detected", async () => {
  const cap = captureConsole()
  try {
    const fakeClient = { app: { log: async () => {} } }
    const plugin = await BuildHooksPlugin({ client: fakeClient }, { verbose: true })
    const t = { callID: "b3", tool: "bash", args: { command: "cd web && npm run build" } }
    await plugin["tool.execute.before"](t, { args: t.args })
    assert.ok(cap.logs.some((l) => l.includes("onBuildStart")))
  } finally {
    cap.restore()
  }
})

test("build-tracker: event command.executed starts a build session", async () => {
  const cap = captureConsole()
  try {
    const fakeClient = { app: { log: async () => {} } }
    const plugin = await BuildHooksPlugin({ client: fakeClient }, { verbose: true })
    await plugin["event"]({ event: { type: "command.executed", command: "vite build" } })
    assert.ok(cap.logs.some((l) => l.includes("onBuildStart")))
  } finally {
    cap.restore()
  }
})

test("build-tracker: false positive guard — comment with 'error' does NOT trigger failure", async () => {
  const cap = captureConsole()
  try {
    const fakeClient = { app: { log: async () => {} } }
    const plugin = await BuildHooksPlugin({ client: fakeClient }, {})
    const t = { callID: "fp1", tool: "bash", args: { command: "npm run build" } }
    await plugin["tool.execute.before"](t, { args: t.args })
    const out = { output: "// TODO: handle error case here\nlet x = 1\nbuild ok" }
    await plugin["tool.execute.after"](t, out)
    assert.ok(!cap.logs.some((l) => l.includes("onBuildFailure")), "yorum satırı false positive")
  } finally {
    cap.restore()
  }
})

test("build-tracker: false positive guard — help text with 'failed' does NOT trigger failure", async () => {
  const cap = captureConsole()
  try {
    const fakeClient = { app: { log: async () => {} } }
    const plugin = await BuildHooksPlugin({ client: fakeClient }, {})
    const t = { callID: "fp2", tool: "bash", args: { command: "cargo build" } }
    await plugin["tool.execute.before"](t, { args: t.args })
    const out = { output: "Usage: cargo build [options]\n  --retry  Retry if previous run failed\nCompiled OK" }
    await plugin["tool.execute.after"](t, out)
    assert.ok(!cap.logs.some((l) => l.includes("onBuildFailure")), "help text false positive")
  } finally {
    cap.restore()
  }
})

test("build-tracker: real rustc error (anchor pattern) IS detected as failure", async () => {
  const cap = captureConsole()
  try {
    const fakeClient = { app: { log: async () => {} } }
    const plugin = await BuildHooksPlugin({ client: fakeClient }, { verbose: true })
    const tC = { callID: "real1", tool: "bash", args: { command: "cargo build" } }
    await plugin["tool.execute.before"](tC, { args: tC.args })
    cap.logs.length = 0
    const errOut = "warning: unused variable\nerror[E0425]: cannot find value `x`\n  --> src/main.rs:5:9"
    const outC = { output: errOut }
    await plugin["tool.execute.after"](tC, outC)
    assert.ok(cap.logs.some((l) => l.includes("onBuildFailure")), "rustc error algılanmalı")
  } finally {
    cap.restore()
  }
})

test("build-tracker: no toast on success, status goes to app.log (toast text leaks into next prompt)", async () => {
  const toasts = []
  const logs = []
  const fakeClient = {
    app: { log: async (m) => { logs.push(m) } },
    tui: { showToast: async (m) => { toasts.push(m) } },
  }
  const plugin = await BuildHooksPlugin({ client: fakeClient }, {})
  const t = { callID: "toast1", tool: "bash", args: { command: "npm run build" } }
  await plugin["tool.execute.before"](t, { args: t.args })
  const out = { output: "build succeeded" }
  await plugin["tool.execute.after"](t, out)
  assert.equal(toasts.length, 0)
  assert.ok(logs.some((l) => l.body.message.includes("Build success")))
  assert.ok(logs.some((l) => l.body.message.includes("npm run build")))
  assert.ok(logs.some((l) => l.body.level === "info"))
})

test("build-tracker: no toast on failure, error goes to app.log", async () => {
  const toasts = []
  const logs = []
  const fakeClient = {
    app: { log: async (m) => { logs.push(m) } },
    tui: { showToast: async (m) => { toasts.push(m) } },
  }
  const plugin = await BuildHooksPlugin({ client: fakeClient }, {})
  const t = { callID: "toast2", tool: "bash", args: { command: "cargo build" } }
  await plugin["tool.execute.before"](t, { args: t.args })
  const out = { output: "error[E0425]: cannot find value `x`" }
  await plugin["tool.execute.after"](t, out)
  assert.equal(toasts.length, 0)
  assert.ok(logs.some((l) => l.body.message.includes("Build failed")))
  assert.ok(logs.some((l) => l.body.level === "error"))
})

test("build-tracker: graceful when tui API is missing", async () => {
  const fakeClient = { app: { log: async () => {} } }
  const plugin = await BuildHooksPlugin({ client: fakeClient }, {})
  const t = { callID: "notoast1", tool: "bash", args: { command: "npm run build" } }
  await plugin["tool.execute.before"](t, { args: t.args })
  await plugin["tool.execute.after"](t, { output: "ok" })
})

test("build-tracker: default silent — no stdout, status still goes to app.log (Termux ghost fix)", async () => {
  const cap = captureConsole()
  try {
    const logs = []
    const fakeClient = { app: { log: async (m) => { logs.push(m) } } }
    const plugin = await BuildHooksPlugin({ client: fakeClient }, {})
    const t = { callID: "silent1", tool: "bash", args: { command: "npm run build" } }
    await plugin["tool.execute.before"](t, { args: t.args })
    assert.equal(cap.logs.length, 0)
    const out = { output: "build succeeded" }
    await plugin["tool.execute.after"](t, out)
    assert.equal(cap.logs.length, 0)
    assert.ok(logs.some((l) => l.body.message.includes("Build success")))
  } finally {
    cap.restore()
  }
})

test("build-tracker: extraErrorPatterns catches pytest FAILED (builtin gap)", async () => {
  const cap = captureConsole()
  try {
    const fakeClient = { app: { log: async () => {} } }
    // Not: session açmak için komut build sayılmalı (after-hook sess.active
    // yoksa erken döner); çıktı regex katmanını test eder.
    const cmd = "npm run build"
    const pytestOut = "FAILED test_x.py::test_bar - assert 1 == 2"
    // Önce kanıt: default listede pytest formatı yok → failure yok.
    const plain = await BuildHooksPlugin({ client: fakeClient }, { verbose: true })
    const t0 = { callID: "py0", tool: "bash", args: { command: cmd } }
    await plain["tool.execute.before"](t0, { args: t0.args })
    await plain["tool.execute.after"](t0, { output: pytestOut })
    assert.ok(!cap.logs.some((l) => l.includes("onBuildFailure")), "builtin misses pytest")
    // Additive desenle yakalanır.
    const plugin = await BuildHooksPlugin(
      { client: fakeClient },
      { verbose: true, extraErrorPatterns: ["^FAILED\\s"] },
    )
    const t = { callID: "py1", tool: "bash", args: { command: cmd } }
    await plugin["tool.execute.before"](t, { args: t.args })
    await plugin["tool.execute.after"](t, { output: pytestOut })
    assert.ok(cap.logs.some((l) => l.includes("onBuildFailure")), "extra pattern hits")
  } finally {
    cap.restore()
  }
})

test("build-tracker: extraErrorPatterns is additive, builtins retained", async () => {
  const cap = captureConsole()
  try {
    const fakeClient = { app: { log: async () => {} } }
    const plugin = await BuildHooksPlugin(
      { client: fakeClient },
      { verbose: true, extraErrorPatterns: ["^FAILED\\s"] },
    )
    const t = { callID: "ad1", tool: "bash", args: { command: "npm run build" } }
    await plugin["tool.execute.before"](t, { args: t.args })
    await plugin["tool.execute.after"](t, { output: "npm ERR! boom" })
    assert.ok(cap.logs.some((l) => l.includes("onBuildFailure")), "builtin still active")
  } finally {
    cap.restore()
  }
})

test("build-tracker: invalid extraErrorPatterns throws at init (fail-loud)", async () => {
  const fakeClient = { app: { log: async () => {} } }
  await assert.rejects(
    BuildHooksPlugin({ client: fakeClient }, { extraErrorPatterns: ["(["] }),
    /invalid extraErrorPatterns/,
  )
})

test("build-tracker: mini-disclosure once (sentinel idempotent, TASK-129)", async () => {
  const fakeClient = { app: { log: async () => {} } }
  const plugin = await BuildHooksPlugin({ client: fakeClient }, {})
  const output = { system: [] }
  await plugin["experimental.chat.system.transform"]({}, output)
  await plugin["experimental.chat.system.transform"]({}, output)
  assert.equal(output.system.length, 1)
  assert.ok(output.system[0].includes("[build-tracker]"), "sentinel")
  assert.ok(output.system[0].includes("extraErrorPatterns"), "feature pointer")
  assert.ok(output.system[0].includes("app.log"), "log semantics")
})

test("build-tracker: array command (hbmon argv) opens a session (TASK-128)", async () => {
  const cap = captureConsole()
  try {
    const fakeClient = { app: { log: async () => {} } }
    const plugin = await BuildHooksPlugin({ client: fakeClient }, { verbose: true })
    const t = {
      callID: "arr1",
      tool: "hbmon_watch",
      args: { command: ["cargo", "build", "--release"] },
    }
    await plugin["tool.execute.before"](t, { args: t.args })
    assert.ok(cap.logs.some((l) => l.includes("onBuildStart")), "argv session opens")
    assert.ok(cap.logs.some((l) => l.includes("cargo build --release")), "argv joined")
  } finally {
    cap.restore()
  }
})

test("build-tracker: pytest session + FAILED output + extra pattern = failure (TASK-128 e2e)", async () => {
  const cap = captureConsole()
  try {
    const fakeClient = { app: { log: async () => {} } }
    const plugin = await BuildHooksPlugin(
      { client: fakeClient },
      { verbose: true, extraErrorPatterns: ["^FAILED\\s"] },
    )
    const t = { callID: "pytest1", tool: "bash", args: { command: "pytest tests/ -x" } }
    await plugin["tool.execute.before"](t, { args: t.args })
    assert.ok(cap.logs.some((l) => l.includes("onBuildStart")), "pytest opens session")
    await plugin["tool.execute.after"](t, { output: "FAILED test_x.py::test_bar - assert" })
    assert.ok(cap.logs.some((l) => l.includes("onBuildFailure")), "failure detected")
  } finally {
    cap.restore()
  }
})
