import test from "node:test"
import assert from "node:assert/strict"
import * as serverEntry from "../dist/plugins/server.js"
import { setupV2, hasHook } from "./v2-harness.mjs"

// V2 (`@opencode/plugin` 2.x): her plugin dosyası `export default
// Plugin.define({ id, setup })` yapar. `server.ts` runtime'da plugin
// olarak yüklenmez — altı tanımı tek noktadan re-export eder.

test("server entry: exposes exactly the six plugin definitions", () => {
  assert.deepEqual(Object.keys(serverEntry).sort(), [
    "buildTracker",
    "contextSaver",
    "cpuLiveness",
    "hbmon",
    "settleNoticer",
    "truncationNoticer",
  ])
  for (const [name, value] of Object.entries(serverEntry)) {
    assert.equal(typeof value, "object", `${name} must be a V2 plugin definition object`)
    assert.equal(typeof value.setup, "function", `${name} must expose setup()`)
    assert.equal(typeof value.id, "string", `${name} must have a stable id`)
  }
})

test("server entry: every definition sets up hooks or tools", async () => {
  for (const [name, def] of Object.entries(serverEntry)) {
    const { sessionHooks, toolHooks, addedTools, cleanup } = await setupV2(def, {})
    const hookCount = Object.keys(sessionHooks).length + Object.keys(toolHooks).length
    assert.ok(
      hookCount > 0 || addedTools.length > 0,
      `${name} must register session/tool hooks or add tools`,
    )
    await cleanup?.()
  }
})

test("server entry: shared options object reaches all definitions", async () => {
  const cs = await setupV2(serverEntry.contextSaver, { enabled: false })
  assert.ok(hasHook(cs.toolHooks, "execute.after"))
  await cs.cleanup?.()
  const bt = await setupV2(serverEntry.buildTracker, { verbose: false })
  assert.ok(hasHook(bt.toolHooks, "execute.after"))
  await bt.cleanup?.()
  const tn = await setupV2(serverEntry.truncationNoticer, {})
  assert.ok(hasHook(tn.toolHooks, "execute.after"))
  await tn.cleanup?.()
  const cl = await setupV2(serverEntry.cpuLiveness, {})
  assert.ok(hasHook(cl.sessionHooks, "context"))
  await cl.cleanup?.()
  const sn = await setupV2(serverEntry.settleNoticer, {})
  assert.ok(hasHook(sn.toolHooks, "execute.after"))
  await sn.cleanup?.()
  const hb = await setupV2(serverEntry.hbmon, {})
  assert.ok(hb.addedTools.some((t) => t.name === "hbmon_wait" && typeof t.execute === "function"))
  await hb.cleanup?.()
})
