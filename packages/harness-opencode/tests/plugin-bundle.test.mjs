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
import { NAMESPACE_SEGMENT_RE } from "../dist/plugins/lib/opencode-compat.js"
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
      assert.ok(
        addedTools.some((t) => t.name === name),
        `${name} registered`,
      )
    }
  } finally {
    await cleanup?.()
  }
})

test("bundle: bir alt-plugin atarsa kalanı yüklenir (izolasyon)", async () => {
  // Slim dersi: domain kurulumları bağımsız korunur. context-saver
  // negatif headChars'ta atar; eski kodda sonrasındaki her şey (hbmon
  // dahil) ölürdü. Kilit: 7 tool yine de kayıtlı.
  const { addedTools, sessionHooks, cleanup } = await setupV2(bundle, { "opencode-context-saver": { headChars: -1 } })
  try {
    for (const name of ["hbmon_watch", "hbmon_wait", "hbmon_status", "bg_run", "bg_status", "bg_logs", "bg_kill"]) {
      assert.ok(
        addedTools.some((t) => t.name === name),
        `izolasyon kırık: ${name} kayıtlı değil`,
      )
    }
    // Boş kilit olmasın: düşen plugin gerçekten düşmüş olmalı (iz yok).
    const e = await sessionContext(sessionHooks, [])
    assert.ok(!systemTexts(e.system).some((t) => t.includes("[context-saver]")), "düşen saver iz bırakmamalı")
  } finally {
    await cleanup?.()
  }
})
test("bundle: namespace host kuralına uyar (NABIZ-011 — sessiz kayıt düşürme)", async () => {
  // opencode namespace'i **segment bazlı** doğruluyor (canlı kanıt
  // 2026-10-02, opencode 2.0.21 binary içi kaynak):
  //   fl(ns) → ns.split(".").every(seg => /^[A-Za-z0-9_-]{1,64}$/.test(seg))
  // Yani nokta AYIRICI (geçerli), her segment 1..64 karakter. Uymayan
  // namespace tool'u `tools/list`'te hiç göstermeden düşürüyor ("Skipping
  // invalid tool registration").
  //
  // DİKKAT: `^[A-Za-z0-9_-]{1,128}$` kuralı namespace'e değil, **fully
  // qualified tool adına** aittir (pl(): `Invalid tool name`). İlk yazımda
  // ikisi karıştırılmıştı; 65+ karakterlik segment sessizce kırılırdı.
  // @opencode/plugin yalnız tip taşıdığı için `tsc` bu hatayı geçirir.
  // Kural tek kaynaktan gelir: `plugins/lib/opencode-compat.ts`
  // (host varsayım tamponu).
  const hostAccepts = (ns) => ns.split(".").every((seg) => NAMESPACE_SEGMENT_RE.test(seg))
  const { addedTools, cleanup } = await setupV2(bundle, {})
  try {
    const namespaced = addedTools.filter((t) => t.options?.namespace !== undefined)
    assert.ok(namespaced.length > 0, "namespace kullanan tool yok — kilit boşa düşmesin")
    for (const t of namespaced) {
      const ns = t.options.namespace
      assert.ok(
        hostAccepts(ns),
        `${t.name} namespace '${ns}' host kuralına uymuyor (segment 1..64, [A-Za-z0-9_-]; tool sessizce düşer)`,
      )
      // Kısa devre değil: 64+ karakter sessiz kırılmayı yakalamalı.
      assert.ok(!hostAccepts("x".repeat(65)), "kural 65 karakteri reddetmeli")
      assert.ok(!hostAccepts("build pulse"), "kural boşluğu reddetmeli")
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
      assert.ok(
        texts.some((t) => t.includes(sentinel)),
        `${sentinel} pushed`,
      )
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
    assert.ok(!texts.some((t) => t.includes("[tn-")), "tn disclosure yok")
    assert.ok(!texts.some((t) => t.includes("[cpu-liveness]")), "cl disclosure yok")
    // ...ama diğerleri kaydolmaya devam eder.
    assert.ok(
      texts.some((t) => t.includes("[context-saver]")),
      "cs duruyor",
    )
    assert.ok(
      texts.some((t) => t.includes("[build-tracker]")),
      "bt duruyor",
    )
    assert.ok(
      texts.some((t) => t.includes("[sn-")),
      "sn duruyor",
    )
    assert.ok(hasHook(toolHooks, "execute.before"), "before hook'ları duruyor")
    assert.ok(
      addedTools.some((t) => t.name === "bg_run"),
      "hbmon tool'ları duruyor",
    )
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

test("bundle: hbmon enabled:false yapısal susar + kapalı disclosure (NABIZ-008)", async () => {
  const hbmon = (await import("../dist/plugins/opencode-hbmon.js")).default
  const { sessionHooks, toolHooks, addedTools, cleanup } = await setupV2(hbmon, { enabled: false })
  try {
    // 7 tool hiç kaydolmaz (stub yok, "unknown tool" döner)
    assert.deepEqual(addedTools, [])
    assert.deepEqual(Object.keys(toolHooks), [])
    // tek görünür iz: neden-yok disclosure'ı, oturum açılışında bir kez
    const e = await sessionContext(sessionHooks, [])
    assert.ok(systemTexts(e.system).join("\n").includes("[hbmon-disabled]"))
    assert.match(systemTexts(e.system).join("\n"), /opencode-hbmon kapalı, bg_run yok/)
    const e2 = await sessionContext(sessionHooks, systemTexts(e.system))
    assert.equal(e2.system.length, e.system.length)
  } finally {
    await cleanup?.()
  }
})

test("bundle: hbmon enabled (default) 7 tool + davranış aynı (NABIZ-008 regresyon)", async () => {
  const hbmon = (await import("../dist/plugins/opencode-hbmon.js")).default
  const { addedTools, cleanup } = await setupV2(hbmon, {})
  try {
    for (const name of ["hbmon_watch", "hbmon_wait", "hbmon_status", "bg_run", "bg_status", "bg_logs", "bg_kill"]) {
      assert.ok(
        addedTools.some((t) => t.name === name),
        `${name} registered`,
      )
    }
  } finally {
    await cleanup?.()
  }
})

test("bundle: namespaced opencode-hbmon enabled:false — tool yok, diğerleri durur (NABIZ-008)", async () => {
  const { sessionHooks, addedTools, cleanup } = await setupV2(bundle, { "opencode-hbmon": { enabled: false } })
  try {
    assert.ok(!addedTools.some((t) => t.name === "bg_run"), "bg_run kaydolmaz")
    const e = await sessionContext(sessionHooks, [])
    const texts = systemTexts(e.system)
    assert.ok(
      texts.some((t) => t.includes("[hbmon-disabled]")),
      "kapalı disclosure var",
    )
    assert.ok(
      texts.some((t) => t.includes("[context-saver]")),
      "cs duruyor",
    )
    assert.ok(
      texts.some((t) => t.includes("[build-tracker]")),
      "bt duruyor",
    )
  } finally {
    await cleanup?.()
  }
})
