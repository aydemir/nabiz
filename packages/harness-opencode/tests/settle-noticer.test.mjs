/**
 * Unit tests for opencode-settle-noticer.
 * Lib mantığını (parse + final + notified + scan + notice) ve hook
 * idempotency'sini hook framework'ünden bağımsız test eder.
 *
 * Not: hook'un kendisi opencode runtime'ında çalışır; burada pure
 * fonksiyonlar + sahte (t, output) objeleriyle davranış test edilir.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  NOTICE_SENTINEL,
  STALE_SENTINEL,
  DISCLOSURE_SENTINEL,
  DISCLOSURE_TEXT,
  DEFAULT_SKIP_CONTAINS,
  DEFAULT_STALE_AFTER_MS,
  parseStatusFile,
  parseLastEvent,
  isFinal,
  notifiedPath,
  isNotified,
  markNotified,
  markStaleNotified,
  isStaleNotified,
  staleNotifiedPath,
  resolveEventDirs,
  scanSettled,
  scanStale,
  buildNotice,
  buildStaleNotice,
  buildPendingSuffix,
} from "nabiz-core/settle-notice"
import settleFactory from "../dist/plugins/opencode-settle-noticer.js"

function mktmp() {
  const d = join(tmpdir(), `sn-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  mkdirSync(d, { recursive: true })
  return d
}

function writeStatus(dir, name, rec) {
  const p = join(dir, `${name}.status.json`)
  writeFileSync(p, JSON.stringify(rec), "utf8")
  return p
}

const PASSED = {
  ts: "2026-09-07T21:12:39Z",
  name: "j1-kanitli",
  event: "PASSED",
  detail: "derleme geçti (2109sn)",
  log: "/tmp/x/j1-kanitli.log",
  exit: 0,
}
const HEARTBEAT = {
  ts: "2026-09-07T21:11:56Z",
  name: "j1-kanitli",
  event: "HEARTBEAT",
  detail: "2065sn geçti",
  log: "/tmp/x/j1-kanitli.log",
}

test("parseStatusFile: real PASSED shape", () => {
  const d = mktmp()
  try {
    const p = writeStatus(d, "j1-kanitli", PASSED)
    const rec = parseStatusFile(p)
    assert.ok(rec)
    assert.equal(rec.name, "j1-kanitli")
    assert.equal(rec.event, "PASSED")
    assert.equal(rec.exit, 0)
    assert.equal(rec.statusPath, p)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("parseStatusFile: HEARTBEAT parses but isFinal false", () => {
  const d = mktmp()
  try {
    // exit yok → parse null (final-dışı kayıtlar forma uymaz)
    const p = writeStatus(d, "j1-kanitli", HEARTBEAT)
    assert.equal(parseStatusFile(p), null)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("parseStatusFile: malformed JSON → null", () => {
  const d = mktmp()
  try {
    const p = join(d, "x.status.json")
    writeFileSync(p, "{bozuk", "utf8")
    assert.equal(parseStatusFile(p), null)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("parseStatusFile: missing file → null, wrong shape → null", () => {
  assert.equal(parseStatusFile(join(tmpdir(), "sn-yok-boyle-dosya.status.json")), null)
  const d = mktmp()
  try {
    const p = join(d, "y.status.json")
    writeFileSync(p, JSON.stringify({ foo: 1 }), "utf8")
    assert.equal(parseStatusFile(p), null)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("isFinal: exit 0/124 true, exit alanı yoksa n/a", () => {
  assert.equal(isFinal({ exit: 0 }), true)
  assert.equal(isFinal({ exit: 124 }), true)
  assert.equal(isFinal({ exit: "124" }), true)
})

test("notified roundtrip: mark → isNotified true, yeni ts → false", () => {
  const d = mktmp()
  try {
    const rec = { ...PASSED, statusPath: join(d, "j.status.json") }
    assert.equal(isNotified(d, rec), false)
    markNotified(d, rec)
    assert.ok(existsSync(notifiedPath(d, "j1-kanitli")))
    assert.equal(isNotified(d, rec), true)
    assert.equal(isNotified(d, { ...rec, ts: "2026-09-08T00:00:00Z" }), false)
    assert.equal(isNotified(d, { ...rec, event: "FAILED" }), false)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("scanSettled: sadece bildirilmemiş finaller", () => {
  const d = mktmp()
  try {
    writeStatus(d, "a", { ...PASSED, name: "a", ts: "2026-09-07T20:00:00Z" })
    writeStatus(d, "b", { ...PASSED, name: "b", event: "FAILED", exit: 1, ts: "2026-09-07T21:00:00Z" })
    writeStatus(d, "c", { ...HEARTBEAT, name: "c" })
    writeFileSync(join(d, "cop.status.json"), "çöp", "utf8")
    const found = scanSettled([d], 20)
    assert.deepEqual(found.map((r) => r.name), ["a", "b"])
    // işaretle → ikinci tara boş
    for (const r of found) markNotified(d, r)
    assert.deepEqual(scanSettled([d], 20), [])
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("scanSettled: yok dizin → [], maxFiles cap", () => {
  assert.deepEqual(scanSettled([join(tmpdir(), "sn-yok-dizin")], 20), [])
  const d = mktmp()
  try {
    for (let i = 0; i < 5; i++) {
      writeStatus(d, `n${i}`, { ...PASSED, name: `n${i}`, ts: `2026-09-07T2${i}:00:00Z` })
    }
    assert.equal(scanSettled([d], 2).length, 2)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("buildNotice: sentinel + ad + olay + exit", () => {
  const txt = buildNotice([{ ...PASSED, statusPath: "/e/j.status.json" }])
  assert.ok(txt.includes(NOTICE_SENTINEL))
  assert.ok(txt.includes("j1-kanitli"))
  assert.ok(txt.includes("PASSED"))
  assert.ok(txt.includes("exit=0"))
  assert.ok(txt.includes("/e/j.status.json"))
})

test("resolveEventDirs: explicit passthrough, env, var olmayan elenir", () => {
  const d = mktmp()
  try {
    assert.deepEqual(resolveEventDirs([d]), [d])
    assert.deepEqual(resolveEventDirs(["/yok-boyle-dizin-sn"]), [])
    const withEnv = resolveEventDirs(undefined, { BUILD_MON_DIR: d }, "/yok-cwd")
    assert.deepEqual(withEnv, [d])
    assert.deepEqual(resolveEventDirs(undefined, {}, "/yok-cwd"), [])
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("hook: bildirilmemiş PASSED → nota eklenir, ikinci çağrı sessiz", async () => {
  const d = mktmp()
  try {
    writeStatus(d, "k", { ...PASSED, name: "k", ts: "2026-09-07T22:00:00Z" })
    const inst = await settleFactory({ directory: "/tmp" }, { eventDirs: [d] })
    const after = inst["tool.execute.after"]
    const out1 = { output: "derleme çıktısı" }
    await after({ tool: "bash", args: {} }, out1)
    assert.ok(out1.output.includes(NOTICE_SENTINEL))
    assert.ok(out1.output.includes(" k PASSED "))
    const out2 = { output: "başka çıktı" }
    await after({ tool: "bash", args: {} }, out2)
    assert.equal(out2.output, "başka çıktı")
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("hook: enabled:false → dokunmaz", async () => {
  const d = mktmp()
  try {
    writeStatus(d, "k", { ...PASSED, name: "k" })
    const inst = await settleFactory({ directory: "/tmp" }, { enabled: false, eventDirs: [d] })
    const out = { output: "x" }
    await inst["tool.execute.after"]({ tool: "bash", args: {} }, out)
    assert.equal(out.output, "x")
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("hook: skip marker varsa → dokunmaz", async () => {
  const d = mktmp()
  try {
    writeStatus(d, "k", { ...PASSED, name: "k" })
    const inst = await settleFactory({ directory: "/tmp" }, { eventDirs: [d] })
    const out = { output: "x" }
    await inst["tool.execute.after"](
      { tool: "bash", args: { command: `ls ${DEFAULT_SKIP_CONTAINS}` } },
      out,
    )
    assert.equal(out.output, "x")
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("hook: disclosure bir kez (sentinel idempotent)", async () => {
  const inst = await settleFactory({ directory: "/tmp" }, {})
  const tr = inst["experimental.chat.system.transform"]
  const out = { system: [] }
  await tr({}, out)
  await tr({}, out)
  assert.equal(out.system.filter((s) => s.includes(DISCLOSURE_SENTINEL)).length, 1)
})

test("buildPendingSuffix: boş → '', dolu → ad+olay+exit", () => {
  assert.equal(buildPendingSuffix([]), "")
  const s = buildPendingSuffix([{ ...PASSED, statusPath: "/e/j.status.json" }])
  assert.ok(s.includes("j1-kanitli"))
  assert.ok(s.includes("PASSED"))
  assert.ok(s.includes("exit=0"))
})

test("transform: bekleyen settle disclosure'a gömülür (snapshot)", async () => {
  const d = mktmp()
  try {
    writeStatus(d, "k", { ...PASSED, name: "k", ts: "2026-09-07T22:00:00Z" })
    const inst2 = await settleFactory({ directory: "/tmp" }, { eventDirs: [d] })
    const out = { system: [] }
    await inst2["experimental.chat.system.transform"]({}, out)
    assert.equal(out.system.length, 1)
    assert.ok(out.system[0].includes(DISCLOSURE_SENTINEL))
    assert.ok(out.system[0].includes("k PASSED (exit=0)"))
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("transform: bekleyen yoksa statik metin (ek yok)", async () => {
  const d = mktmp()
  try {
    const inst = await settleFactory({ directory: "/tmp" }, { eventDirs: [d] })
    const out = { system: [] }
    await inst["experimental.chat.system.transform"]({}, out)
    assert.equal(out.system.length, 1)
    assert.ok(!out.system[0].includes("Pending settles:"))
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("disclosure: hbmon kapsam-dışı cümlesi (TASK-129)", () => {
  assert.ok(DISCLOSURE_TEXT.includes("hbmon-watched builds are NOT covered"), "scope sentence")
  assert.ok(DISCLOSURE_TEXT.includes("hbmon_wait"), "alternative pointer")
})

// --- TASK-131 stale scan ---

function staleFixture(files) {
  // files: [{name, event, ts, exit?}] → tmp event dir (çağıran temizler).
  const dir = mkdtempSync(join(tmpdir(), "sn-stale-"))
  for (const f of files) {
    const rec = { name: f.name, event: f.event, ts: f.ts }
    if (f.exit !== undefined) rec.exit = f.exit
    writeFileSync(join(dir, `${f.name}.status.json`), JSON.stringify(rec))
  }
  return dir
}

const oldTs = (msAgo) => new Date(Date.now() - msAgo).toISOString()

test("scanStale: old non-final found, fresh ignored", () => {
  const dir = staleFixture([
    { name: "dead", event: "HEARTBEAT", ts: oldTs(600000) },
    { name: "live", event: "HEARTBEAT", ts: oldTs(10000) },
  ])
  try {
    const found = scanStale([dir], DEFAULT_STALE_AFTER_MS)
    assert.equal(found.map((r) => r.name).join(","), "dead")
    assert.equal(found[0].event, "HEARTBEAT")
    assert.ok(found[0].ageMs > DEFAULT_STALE_AFTER_MS)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("scanStale: finals never stale (settle path owns them)", () => {
  const dir = staleFixture([
    { name: "fin", event: "FAILED", ts: oldTs(3600000), exit: 1 },
  ])
  try {
    assert.deepEqual(scanStale([dir], 1000), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("scanStale: invalid ts skipped gracefully", () => {
  const dir = staleFixture([{ name: "bad", event: "HEARTBEAT", ts: "not-a-date" }])
  try {
    assert.deepEqual(scanStale([dir], 1000), [])
    assert.equal(parseLastEvent(join(dir, "bad.status.json")), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("scanStale: once-only marker, new event re-arms", () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-stale-"))
  try {
    const ts1 = new Date(Date.now() - 600000).toISOString()
    const rec1 = { name: "flap", event: "HEARTBEAT", ts: ts1 }
    writeFileSync(join(dir, "flap.status.json"), JSON.stringify(rec1))
    assert.equal(scanStale([dir], 1000).length, 1)
    markStaleNotified(dir, rec1)
    assert.ok(isStaleNotified(dir, rec1))
    assert.deepEqual(scanStale([dir], 1000), [])
    // Yeni olay (yeni ts) işareti sıfırlar — ayrı reset mantığı yok:
    const ts2 = new Date(Date.now() - 500000).toISOString()
    writeFileSync(join(dir, "flap.status.json"), JSON.stringify({ name: "flap", event: "HEARTBEAT", ts: ts2 }))
    const found2 = scanStale([dir], 1000)
    assert.equal(found2.length, 1)
    assert.equal(found2[0].ts, ts2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("scanStale: custom threshold respected", () => {
  const dir = staleFixture([{ name: "mid", event: "STARTED", ts: oldTs(5000) }])
  try {
    assert.equal(scanStale([dir], 3600000).length, 0)
    assert.equal(scanStale([dir], 1000).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("buildStaleNotice: format", () => {
  const out = buildStaleNotice([
    { name: "dead", event: "HEARTBEAT", ts: oldTs(65000), ageMs: 65000, statusPath: "/e/dead.status.json" },
  ])
  assert.ok(out.includes(STALE_SENTINEL), "sentinel")
  assert.ok(out.includes("dead"), "name")
  assert.ok(out.includes("HEARTBEAT"), "event")
  assert.ok(out.includes("1dk"), "age")
  assert.ok(out.includes("/e/dead.status.json"), "path")
})

test("hook: stale notice appended once, second call silent (TASK-131)", async () => {
  const dir = staleFixture([{ name: "gone", event: "HEARTBEAT", ts: oldTs(600000) }])
  try {
    const inst = await settleFactory({ config: { eventDirs: [dir] } }, {})
    const out1 = { output: "ok" }
    await inst["tool.execute.after"]({ callID: "s1", tool: "bash", args: {} }, out1)
    assert.ok(out1.output.includes(STALE_SENTINEL), "stale appended")
    assert.ok(out1.output.includes("gone"), "name in notice")
    const out2 = { output: "ok" }
    await inst["tool.execute.after"]({ callID: "s2", tool: "bash", args: {} }, out2)
    assert.ok(!out2.output.includes(STALE_SENTINEL), "once-only")
    assert.ok(existsSync(staleNotifiedPath(dir, "gone")), "marker file")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("hook: invalid staleAfterMs falls back to default (fail-soft)", async () => {
  const dir = staleFixture([{ name: "x", event: "HEARTBEAT", ts: oldTs(10000) }])
  try {
    const inst = await settleFactory({ config: { eventDirs: [dir], staleAfterMs: -5 } }, {})
    const out = { output: "ok" }
    await inst["tool.execute.after"]({ callID: "s3", tool: "bash", args: {} }, out)
    assert.ok(!out.output.includes(STALE_SENTINEL), "10sn < 180sn default")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("disclosure: stale clause present (TASK-131)", () => {
  assert.ok(DISCLOSURE_TEXT.includes("[sn] stale:"), "stale pointer")
})
