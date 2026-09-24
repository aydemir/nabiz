import test from "node:test"
import assert from "node:assert/strict"
import * as serverEntry from "../dist/plugins/server.js"

// opencode 1.18.29 `opencode plugin <pkg>` manifest sözleşmesi:
// exports["./server"] çözümlenmeli ve modülün TÜM export değerleri
// function olmalı (getLegacyPlugins Object.values iterate eder,
// function olmayan tek export tüm paketi düşürür).

test("server entry: exposes exactly the six plugin factories", () => {
  assert.deepEqual(Object.keys(serverEntry).sort(), [
    "buildTracker",
    "contextSaver",
    "cpuLiveness",
    "hbmon",
    "settleNoticer",
    "truncationNoticer",
  ])
  for (const [name, value] of Object.entries(serverEntry)) {
    assert.equal(typeof value, "function", `${name} must be a function`)
  }
})

test("server entry: every factory instantiates with hooks", async () => {
  for (const [name, factory] of Object.entries(serverEntry)) {
    const instance = await factory({ directory: "/tmp" }, {})
    assert.ok(
      Object.keys(instance).length > 0,
      `${name} instance must expose hooks`,
    )
    const hook =
      instance.dispose ??
      instance["tool.execute.after"] ??
      instance["experimental.chat.system.transform"]
    // Custom-tool plugin'leri (hbmon ilk örneği): tool.*.execute sayılır.
    const tools = instance.tool ?? {}
    const hasCallableTool = Object.values(tools).some(
      (t) => t !== null && typeof t === "object" && typeof t.execute === "function",
    )
    assert.ok(
      typeof hook === "function" || hasCallableTool,
      `${name} must expose a callable hook or tool`,
    )
  }
})

test("server entry: shared options object reaches all factories", async () => {
  const cs = await serverEntry.contextSaver({ directory: "/tmp" }, { enabled: false })
  assert.equal(typeof cs["tool.execute.after"], "function")
  const bt = await serverEntry.buildTracker({ directory: "/tmp" }, { verbose: false })
  assert.equal(typeof bt["tool.execute.after"], "function")
  const tn = await serverEntry.truncationNoticer({ directory: "/tmp" }, {})
  assert.equal(typeof tn["tool.execute.after"], "function")
  const cl = await serverEntry.cpuLiveness({ directory: "/tmp" }, {})
  assert.equal(typeof cl["experimental.chat.system.transform"], "function")
  const sn = await serverEntry.settleNoticer({ directory: "/tmp" }, {})
  assert.equal(typeof sn["tool.execute.after"], "function")
  const hb = await serverEntry.hbmon({ directory: "/tmp" }, {})
  assert.equal(typeof hb.tool.hbmon_wait.execute, "function")
})
