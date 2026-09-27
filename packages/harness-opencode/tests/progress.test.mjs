/**
 * NABIZ-005 testleri: events.jsonl reuse + bg_status zenginleştirmesi.
 *
 * Kapsam: parse (bozuk satır atlanır), readLastProgress (son eşleşme,
 * name filtresi, fail-open), formatProgress, bg_status fallback
 * (bg kaydı yok + events eşleşmesi → progress; eşleşme yok → HATA).
 * Kilit: polling YOK — kaynakta `setInterval`/`setTimeout` taraması.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  formatProgress,
  parseProgressLine,
  readLastProgress,
} from "nabiz-core/progress"
import { resolveEventDirs } from "nabiz-core/settle-notice"
import hbmonFactory from "../dist/plugins/opencode-hbmon.js"
import { setupV2 } from "./v2-harness.mjs"

function fixtureDir(lines) {
  const d = mkdtempSync(join(tmpdir(), "nabiz-progress-"))
  writeFileSync(join(d, "events.jsonl"), lines.join("\n") + "\n")
  return d
}

const L = (o) => JSON.stringify(o)

test("parse: geçerli kayıt + bozuk satırlar atlanır", () => {
  const ok = parseProgressLine(
    L({ ts: "t", name: "j", event: "HEARTBEAT", detail: "d", log: "l" }),
  )
  assert.deepEqual(ok, { ts: "t", name: "j", event: "HEARTBEAT", detail: "d" })
  assert.equal(parseProgressLine("bozuk {"), null)
  assert.equal(parseProgressLine(""), null)
  assert.equal(parseProgressLine(L({ ts: "t" })), null)
  const withExit = parseProgressLine(
    L({ ts: "t", name: "j", event: "PASSED", detail: "d", exit: 0 }),
  )
  assert.equal(withExit?.exit, 0)
})

test("readLastProgress: son eşleşme kazanır, name filtresi", () => {
  const d = fixtureDir([
    L({ ts: "t1", name: "a", event: "STARTED", detail: "başladı" }),
    L({ ts: "t2", name: "b", event: "STARTED", detail: "başladı" }),
    L({ ts: "t3", name: "a", event: "HEARTBEAT", detail: "10sn geçti" }),
    "bozuk satır",
    L({ ts: "t4", name: "a", event: "STALLED", detail: "asılı şüphesi" }),
  ])
  try {
    const r = readLastProgress([d], "a")
    assert.equal(r?.event, "STALLED")
    assert.equal(r?.detail, "asılı şüphesi")
    assert.equal(readLastProgress([d], "yok")?.event, undefined)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("readLastProgress: fail-open (dizin/dosya yok)", () => {
  assert.equal(readLastProgress(["/yok/böyle-dizin"], "a"), undefined)
  const d = mkdtempSync(join(tmpdir(), "nabiz-progress-bos-"))
  try {
    assert.equal(readLastProgress([d], "a"), undefined)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("formatProgress: exit'li / exit'siz", () => {
  assert.equal(
    formatProgress({ ts: "t", name: "a", event: "HEARTBEAT", detail: "d" }),
    "progress: HEARTBEAT (t): d",
  )
  assert.equal(
    formatProgress({ ts: "t", name: "a", event: "PASSED", detail: "d", exit: 0 }),
    "progress: PASSED (t): d (exit=0)",
  )
})

test("kaynakta polling yok", () => {
  const src = readFileSync(
    new URL("../../core/src/progress.ts", import.meta.url),
    "utf8",
  )
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  assert.ok(!code.includes("setInterval("), "setInterval çağrısı yasak")
  assert.ok(!code.includes("setTimeout("), "setTimeout çağrısı yasak")
})

test("bg_status: bg kaydı yok + events eşleşmesi → progress; yoksa HATA", async () => {
  const d = fixtureDir([
    L({ ts: "t1", name: "uzun-is", event: "STARTED", detail: "başladı" }),
    L({ ts: "t2", name: "uzun-is", event: "HEARTBEAT", detail: "30sn geçti" }),
  ])
  const prev = process.env.BUILD_MON_DIR
  process.env.BUILD_MON_DIR = d
  try {
    const { addedTools } = await setupV2(hbmonFactory, {})
    const bgStatus = addedTools.find((t) => t.name === "bg_status")
    assert.ok(bgStatus, "bg_status kayıtlı")
    const hit = await bgStatus.execute({ id: "uzun-is" }, {})
    assert.match(String(hit.content), /progress: HEARTBEAT \(t2\): 30sn geçti/)
    assert.match(String(hit.content), /build-mon izlemesi/)
    const miss = await bgStatus.execute({ id: "hicbir-sey" }, {})
    assert.match(String(miss.content), /bg_status HATA/)
  } finally {
    if (prev === undefined) delete process.env.BUILD_MON_DIR
    else process.env.BUILD_MON_DIR = prev
    rmSync(d, { recursive: true, force: true })
  }
})

test("resolveEventDirs BUILD_MON_DIR'i çözer", () => {
  const d = mkdtempSync(join(tmpdir(), "nabiz-progress-env-"))
  try {
    const dirs = resolveEventDirs(undefined, { BUILD_MON_DIR: d }, "/yok")
    assert.deepEqual(dirs, [d])
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})
