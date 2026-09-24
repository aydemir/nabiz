/**
 * Unit tests for opencode-cpu-liveness disclosure.
 * Önceki disclosure testleriyle aynı pattern (TASK-107/111):
 * hook framework'ünden bağımsız — sabitler + transform hook davranışı.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"
import {
  buildCpuLivenessText,
  CPU_LIVENESS_SENTINEL,
  CPU_LIVENESS_TEXT,
  resolveAgentPath,
} from "nabiz-core/cpu-liveness-disclosure"
import CpuLivenessPlugin from "../dist/plugins/opencode-cpu-liveness.js"

// Monorepo: çözümleme çağıranın konumundan yapılır — harness plugin dist'i çapa.
const PLUGIN_URL = pathToFileURL(
  join(dirname(fileURLToPath(new URL(".", import.meta.url))), "dist", "plugins", "opencode-cpu-liveness.js"),
).href

test("sentinel is bracketed marker", () => {
  assert.equal(CPU_LIVENESS_SENTINEL, "[cpu-liveness]")
})

test("text contains sentinel + agent invocation + exit codes", () => {
  assert.ok(CPU_LIVENESS_TEXT.includes(CPU_LIVENESS_SENTINEL))
  assert.ok(CPU_LIVENESS_TEXT.includes("cpu-liveness-agent"))
  assert.ok(CPU_LIVENESS_TEXT.includes("0=clean"))
  assert.ok(CPU_LIVENESS_TEXT.includes("--allow-kill"))
})

test("text is self-sufficient: example + flag placement + shell-join note", () => {
  assert.ok(CPU_LIVENESS_TEXT.includes("npm run build"))
  assert.ok(CPU_LIVENESS_TEXT.includes("BEFORE --"))
  assert.ok(CPU_LIVENESS_TEXT.includes("/bin/bash -c"))
})

test("resolveAgentPath: finds real agent script (no npx/registry needed)", () => {
  const p = resolveAgentPath(PLUGIN_URL)
  assert.ok(p, "agent path must resolve inside repo")
  assert.ok(p.endsWith("cpu-liveness-agent.js"))
})

test("buildCpuLivenessText: absolute node path when resolved, npx fallback when null", () => {
  const withPath = buildCpuLivenessText("/x/cpu-liveness-agent.js")
  assert.ok(withPath.includes("node /x/cpu-liveness-agent.js --"))
  assert.ok(!withPath.includes("npx cpu-liveness-agent"))
  assert.equal(buildCpuLivenessText(null), CPU_LIVENESS_TEXT)
})

test("transform hook: pushes absolute-path text (cross-project safe)", async () => {
  const instance = await CpuLivenessPlugin({ directory: "/tmp" }, {})
  const output = { system: [] }
  await instance["experimental.chat.system.transform"]({}, output)
  assert.equal(output.system.length, 1)
  assert.ok(output.system[0].includes("cpu-liveness-agent.js"))
  assert.ok(!output.system[0].includes("npx cpu-liveness-agent"))
})

test("transform hook: pushes disclosure once (idempotent)", async () => {
  const instance = await CpuLivenessPlugin({ directory: "/tmp" }, {})
  const output = { system: [] }
  await instance["experimental.chat.system.transform"]({}, output)
  assert.equal(output.system.length, 1)
  assert.ok(output.system[0].includes(CPU_LIVENESS_SENTINEL))
  // second call: no duplicate
  await instance["experimental.chat.system.transform"]({}, output)
  assert.equal(output.system.length, 1)
})

test("transform hook: skips when already disclosed", async () => {
  const instance = await CpuLivenessPlugin({ directory: "/tmp" }, {})
  const output = { system: ["earlier [cpu-liveness] note"] }
  await instance["experimental.chat.system.transform"]({}, output)
  assert.equal(output.system.length, 1)
})

test("transform hook: enabled:false disables disclosure", async () => {
  const instance = await CpuLivenessPlugin(
    { directory: "/tmp", config: { enabled: false } },
    {},
  )
  const output = { system: [] }
  await instance["experimental.chat.system.transform"]({}, output)
  assert.equal(output.system.length, 0)
})

test("drift guard: builder text is info-equivalent to static fallback", () => {
  // buildCpuLivenessText (canlı metin) ile CPU_LIVENESS_TEXT (fallback)
  // ayrışırsa LLM oturuma göre farklı bilgi alır (2026-09-10: ioGraceRounds
  // cümlesi builder'da yoktu). Kilit bilgi parçaları ikisinde de olmalı.
  const live = buildCpuLivenessText("/tmp/fake-agent.js")
  for (const frag of [
    "ioGraceRounds",
    "Downloading/Locking/Waiting",
    "0=clean",
    "--allow-kill",
    "/bin/bash -c",
    "pluginOptions.opencode-cpu-liveness.enabled",
  ]) {
    assert.ok(CPU_LIVENESS_TEXT.includes(frag), `fallback has ${frag}`)
    assert.ok(live.includes(frag), `builder has ${frag}`)
  }
})
