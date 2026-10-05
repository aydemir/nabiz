/**
 * Unit tests for opencode-nabiz-updater.
 *
 * Kapsam iki katman:
 *   1. `nabiz-core/updater-notice` saf mantığı — sürüm karşılaştırma,
 *      bildirim metni, `checkForUpdate` (ağ callback'i ENJEKTE EDİLİR).
 *   2. Plugin bootstrap'ı — kill-switch, sentinel idempotency, gerçek
 *      `createRegistryFetcher` yolu (yalnız `globalThis.fetch` stub'lanır,
 *      dosya sistemine ve gerçek network'e dokunulmaz).
 *
 * Not: updater'ın kendisi hiçbir şey kurmaz; yalnız haber verir. Bu yüzden
 * testlerde de kurulum yan etkisi beklenmez.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  buildUpdateNotice,
  checkForUpdate,
  compareVersions,
  createRegistryFetcher,
  DEFAULT_TIMEOUT_MS,
  formatSummary,
  isOutdated,
  UPDATE_SENTINEL,
} from "nabiz-core/updater-notice"
import UpdaterPlugin from "../dist/plugins/opencode-nabiz-updater.js"
import { hasHook, sessionContext, setupV2, systemTexts } from "./v2-harness.mjs"

test("compareVersions: sayısal sıra", () => {
  assert.ok(compareVersions("1.2.0", "1.1.0") > 0)
  assert.ok(compareVersions("1.1.0", "1.2.0") < 0)
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0)
  assert.ok(compareVersions("2.0.0", "1.99.99") > 0)
})

test("compareVersions: eksik segmentler 0 sayılır", () => {
  assert.equal(compareVersions("1.0", "1.0.0"), 0)
  assert.ok(compareVersions("1.0.1", "1.0") > 0)
})

test("compareVersions: prerelease/bozuk segment yok sayılır", () => {
  assert.equal(compareVersions("1.2.0-rc.1", "1.2.0"), 0)
  assert.equal(compareVersions("1.x.0", "1.0.0"), 0)
})

test("isOutdated: yalnız gerideyse true", () => {
  assert.equal(isOutdated("1.0.0", "1.1.0"), true)
  assert.equal(isOutdated("1.0.0", "1.0.0"), false)
  assert.equal(isOutdated("1.2.0", "1.1.0"), false)
})

test("isOutdated: eksik taraf bozuk sürüm → false (sessiz)", () => {
  assert.equal(isOutdated("", "1.1.0"), false)
  assert.equal(isOutdated("1.0.0", ""), false)
})

test("buildUpdateNotice: sentinel taşır, güncelleme yapma uyarısı verir", () => {
  const notice = buildUpdateNotice({ installed: "1.0.0", latest: "1.1.0" })
  assert.ok(notice.includes(UPDATE_SENTINEL))
  assert.ok(notice.includes("1.0.0"))
  assert.ok(notice.includes("1.1.0"))
  assert.ok(/kurma|build|setup\.mjs/i.test(notice))
})

test("formatSummary: kısa özet", () => {
  assert.equal(formatSummary({ installed: "1.0.0", latest: "1.1.0" }), "nabiz-opencode 1.0.0 → 1.1.0")
})

test("checkForUpdate: gerideyse outdated", async () => {
  const result = await checkForUpdate("1.0.0", async () => "1.1.0")
  assert.deepEqual(result, { installed: "1.0.0", latest: "1.1.0", outdated: true })
})

test("checkForUpdate: güncelse outdated değil", async () => {
  const result = await checkForUpdate("1.0.0", async () => "1.0.0")
  assert.equal(result.outdated, false)
})

test("checkForUpdate: uzak sürüm yoksa sessiz", async () => {
  const result = await checkForUpdate("1.0.0", async () => undefined)
  assert.deepEqual(result, { installed: "1.0.0", outdated: false })
})

test("checkForUpdate: ağ hatası throw etse bile updater çökmüyor", async () => {
  const result = await checkForUpdate("1.0.0", async () => {
    throw new Error("network down")
  })
  assert.deepEqual(result, { installed: "1.0.0", outdated: false })
})

test("checkForUpdate: kurulu sürüm yoksa ağa hiç gidilmiyor", async () => {
  let called = false
  const result = await checkForUpdate("", async () => {
    called = true
    return "1.1.0"
  })
  assert.equal(called, false)
  assert.equal(result.outdated, false)
})

test("createRegistryFetcher: dist-tags.latest okunur", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ "dist-tags": { latest: "9.9.9" } }) })
  try {
    assert.equal(await createRegistryFetcher()(), "9.9.9")
  } finally {
    globalThis.fetch = original
  }
})

test("createRegistryFetcher: 404 (registry'de yok) undefined, hata değil", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
  try {
    assert.equal(await createRegistryFetcher()(), undefined)
  } finally {
    globalThis.fetch = original
  }
})

test("createRegistryFetcher: bozuk gövde undefined", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  try {
    assert.equal(await createRegistryFetcher()(), undefined)
  } finally {
    globalThis.fetch = original
  }
})

test("plugin: enabled:false → hiç hook kaydolmaz (kill-switch)", async () => {
  const { sessionHooks } = await setupV2(UpdaterPlugin, { enabled: false })
  assert.equal(hasHook(sessionHooks, "context"), false)
})

test("plugin: geride sürüm varsa sentinel'li bildirim gömülür", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ "dist-tags": { latest: "99.0.0" } }) })
  try {
    const { sessionHooks } = await setupV2(UpdaterPlugin, {})
    const event = await sessionContext(sessionHooks)
    const joined = systemTexts(event.system).join("\n")
    assert.ok(joined.includes(UPDATE_SENTINEL))
    assert.ok(joined.includes("99.0.0"))
  } finally {
    globalThis.fetch = original
  }
})

test("plugin: sürüm güncelse hiçbir şey gömülmez", async () => {
  const original = globalThis.fetch
  // Plugin `dist/plugins/` altından `../../package.json` okur; test de aynı
  // manifesti okur — hardcode sürüm yazmıyoruz, kurulu olanla karşılaştırıyoruz.
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ "dist-tags": { latest: manifest.version } }) })
  try {
    const { sessionHooks } = await setupV2(UpdaterPlugin, {})
    const event = await sessionContext(sessionHooks)
    assert.equal(systemTexts(event.system).join("\n").includes(UPDATE_SENTINEL), false)
  } finally {
    globalThis.fetch = original
  }
})

test("plugin: ağ hatasında context hook'u çökmüyor", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("offline")
  }
  try {
    const { sessionHooks } = await setupV2(UpdaterPlugin, {})
    const event = await sessionContext(sessionHooks)
    assert.ok(Array.isArray(event.system))
  } finally {
    globalThis.fetch = original
  }
})

test("plugin: sentinel zaten varsa tekrar kontrol edilmiyor", async () => {
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    return { ok: true, json: async () => ({ "dist-tags": { latest: "99.0.0" } }) }
  }
  try {
    const { sessionHooks } = await setupV2(UpdaterPlugin, {})
    await sessionContext(sessionHooks, [`${UPDATE_SENTINEL} önceki oturumdan`])
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = original
  }
})

test("createRegistryFetcher: varsayılan timeout ölçülen soğuk isteği kesmemeli (regresyon)", () => {
  // Canlı ölçüm 2026-10-05: registry'ye ilk `fetch` (DNS + TLS) ~5.4 sn sürdü.
  // 5 sn'lik timeout onu AbortError ile kesiyor, `catch` yutup `undefined`
  // dönüyor ve `checkForUpdate` bunu "güncelleme yok" sayıyordu — yani paket
  // registry'de olmasına rağmen updater sessizce hiç bildirim vermiyordu.
  // Yukarıdaki fetcher testlerinin hepsi `fetch`'i ANINDA stub'ladığı için bu
  // eşik hiç ölçülmemişti; burada sabitleniyor.
  assert.ok(
    DEFAULT_TIMEOUT_MS >= 10_000,
    `varsayılan timeout ${DEFAULT_TIMEOUT_MS}ms; ölçülen soğuk istek ~5.4 sn, onun üstünde olmalı`,
  )
})

test("createRegistryFetcher: explicit timeout aşılınca sessiz undefined (fail-quiet)", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (...args) =>
    await new Promise((_resolve, reject) => {
      args[1].signal.addEventListener("abort", () => reject(new Error("aborted")))
    })
  try {
    const fetcher = createRegistryFetcher("nabiz-opencode", "https://registry.npmjs.org", 5)
    assert.equal(await fetcher(), undefined)
  } finally {
    globalThis.fetch = original
  }
})
