/**
 * Tests for the nabiz bundle package (`plugin/index.ts`).
 *
 * V2 bir dizinden SADECE index.ts yükler; bundle altı kurulumu tek
 * `nabiz` id'si altında toplar. Davranış sözleşmesi: altı dosyanın
 * ayrı yüklenişiyle aynı hook'lar + tool'lar kaydolur, sıra korunur
 * (context-saver kırpması noticer marker'larından önce).
 */

import test from "node:test"
import assert from "node:assert/strict"
import bundle from "../dist/plugin/index.js"
import { setupV2, toolAfter, sessionContext, systemTexts, hasHook } from "./v2-harness.mjs"

test("bundle: id nabiz + setup var", () => {
  assert.equal(bundle.id, "nabiz")
  assert.equal(typeof bundle.setup, "function")
})

test("bundle: tüm hook'lar + 7 hbmon tool'u kaydolur", async () => {
  const { sessionHooks, toolHooks, addedTools, cleanup } = await setupV2(bundle, {})
  try {
    assert.ok(hasHook(sessionHooks, "context"), "disclosure hook")
    assert.ok(hasHook(sessionHooks, "prompt"), "prompt hook")
    assert.ok(hasHook(toolHooks, "execute.before"))
    assert.ok(hasHook(toolHooks, "execute.after"))
    for (const name of ["hbmon_watch", "hbmon_wait", "hbmon_status", "bg_run", "bg_status", "bg_logs", "bg_kill"]) {
      assert.ok(addedTools.some((t) => t.name === name), `${name} registered`)
    }
  } finally {
    await cleanup?.()
  }
})

test("bundle: disclosure'lar tek context hook'unda birleşir", async () => {
  const { sessionHooks, cleanup } = await setupV2(bundle, {})
  try {
    const e = await sessionContext(sessionHooks, [])
    const texts = systemTexts(e.system)
    for (const sentinel of ["[context-saver]", "[build-tracker]", "[tn-", "[cpu-liveness]", "[sn-"]) {
      assert.ok(texts.some((t) => t.includes(sentinel)), `${sentinel} pushed`)
    }
    // İkinci çağrı tekrar eklemez (idempotent).
    const e2 = await sessionContext(sessionHooks, e.system)
    assert.equal(e2.system.length, e.system.length)
  } finally {
    await cleanup?.()
  }
})

test("bundle: prune sırası korunur (context-saver önce)", async () => {
  const { toolHooks, cleanup } = await setupV2(bundle, {})
  try {
    const big = "z".repeat(5000)
    const out = await toolAfter(toolHooks, {
      id: "ord1",
      input: { command: "cat big" },
      output: big,
    })
    assert.ok(out.includes("pruned:"), "prune uygulandı")
  } finally {
    await cleanup?.()
  }
})

test("bundle: namespaced sub-options disable one plugin, others stay", async () => {
  const { sessionHooks, toolHooks, addedTools, cleanup } = await setupV2(bundle, {
    "opencode-truncation-noticer": { enabled: false },
    "opencode-cpu-liveness": { enabled: false },
  })
  try {
    // Gated plugin'lerin hook'u yok...
    const e = await sessionContext(sessionHooks, [])
    const texts = systemTexts(e.system)
    assert.ok(!texts.some((t) => t.includes("[tn-"))), "tn disclosure yok"
    assert.ok(!texts.some((t) => t.includes("[cpu-liveness]")), "cl disclosure yok")
    // ...ama diğerleri kaydolmaya devam eder.
    assert.ok(texts.some((t) => t.includes("[context-saver]")), "cs duruyor")
    assert.ok(texts.some((t) => t.includes("[build-tracker]")), "bt duruyor")
    assert.ok(texts.some((t) => t.includes("[sn-")) , "sn duruyor")
    assert.ok(hasHook(toolHooks, "execute.before"), "before hook'ları duruyor")
    assert.ok(addedTools.some((t) => t.name === "bg_run"), "hbmon tool'ları duruyor")
  } finally {
    await cleanup?.()
  }
})

test("bundle: sub-bag overrides shared keys", async () => {
  const big = "z".repeat(5000)
  // Paylaşılan compressThreshold:600 → prune olurdu; alt-çanta üstüne yazar.
  const h = await setupV2(bundle, {
    compressThreshold: 600,
    "opencode-context-saver": { compressThreshold: 100000 },
  })
  try {
    const out = await toolAfter(h.toolHooks, { id: "ov1", input: { command: "x" }, output: big })
    assert.equal(out, big, "sub-bag kazandı, prune yok")
  } finally {
    await h.cleanup?.()
  }
  // Alt-çanta yoksa paylaşılan değer geçer.
  const h2 = await setupV2(bundle, { compressThreshold: 600 })
  try {
    const out = await toolAfter(h2.toolHooks, { id: "ov2", input: { command: "x" }, output: big })
    assert.ok(out.includes("pruned:"), "paylaşılan değer geçer")
  } finally {
    await h2.cleanup?.()
  }
})

test("bundle: enabled:false tek kill-switch (hiçbir şey kaydolmaz)", async () => {
  const { sessionHooks, toolHooks, addedTools, cleanup } = await setupV2(bundle, { enabled: false })
  try {
    assert.deepEqual(Object.keys(sessionHooks), [])
    assert.deepEqual(Object.keys(toolHooks), [])
    assert.deepEqual(addedTools, [])
  } finally {
    await cleanup?.()
  }
})

test("bundle: build-tracker enabled:false tek başına da susar", async () => {
  const buildTracker = (await import("../dist/plugins/opencode-build-tracker.js")).default
  const { sessionHooks, toolHooks, cleanup } = await setupV2(buildTracker, { enabled: false })
  try {
    assert.deepEqual(Object.keys(sessionHooks), [])
    assert.deepEqual(Object.keys(toolHooks), [])
  } finally {
    await cleanup?.()
  }
})
