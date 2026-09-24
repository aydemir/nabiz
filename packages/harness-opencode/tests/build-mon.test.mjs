/**
 * Regression tests for scripts/build-mon.mjs push/event channels.
 *
 * Manuel smoke testlerin (TASK-122) otomatik hali: script child-process
 * olarak koşturulur, stdout banner + events.jsonl + status/result +
 * log silme/arşivleme + rotasyon assert edilir.
 *
 * Yavaş yollar deterministik marjlarla kapsanır: --kill-on-stall
 * (uzun uyuyan proses, exit 111) ve INTERRUPTED (monitöre TERM,
 * exit 143). Hızlı yollar (--heartbeat 0, küçük --stall-after/--timeout)
 * kullanılır.
 *
 * TASK-127 portu: bash bağımlılığı yok. Adapter `process.execPath` ile
 * koşturulur; komut payload'ları `true`/`sleep`/`bash -c` yerine
 * `node -e` ile verilir (win32'de `true`/`sleep` yok, tırnak taşıma yok —
 * argv dizisi CreateProcess'e birebir taşınır).
 */

import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"

const SCRIPT = fileURLToPath(new URL("../scripts/build-mon.mjs", import.meta.url))
const ROOT = dirname(dirname(fileURLToPath(new URL(".", import.meta.url))))
const NODE = process.execPath

function mktmp() {
  return mkdtempSync(join(tmpdir(), "bm-test-"))
}

function run(args, execTimeout = 30000) {
  try {
    const stdout = execFileSync(NODE, [SCRIPT, ...args], {
      encoding: "utf8",
      timeout: execTimeout,
      cwd: ROOT,
    })
    return { exit: 0, stdout }
  } catch (e) {
    return { exit: e.status ?? -1, stdout: String(e.stdout ?? "") }
  }
}

function events(dir) {
  const raw = readFileSync(join(dir, "events.jsonl"), "utf8").trim()
  return raw.length === 0 ? [] : raw.split("\n").map((l) => JSON.parse(l))
}

function ls(dir) {
  return existsSync(dir) ? readdirSync(dir) : []
}

// `true` karşılığı (win32'de `true` ikiliği yok).
const OK = [NODE, "-e", ""]
// `sleep N` karşılığı (win32'de `sleep` yok).
const sleepCmd = (ms) => [NODE, "-e", `setTimeout(()=>{}, ${ms})`]

test("PASSED: exit 0 + banner + events + log silinir", () => {
  const d = mktmp()
  const r = run(["--name", "t1", "--event-dir", d, "--heartbeat", "0", "--", ...OK])
  assert.equal(r.exit, 0)
  assert.ok(r.stdout.includes("<<< BUILD-MON [t1] PASSED"))
  const evs = events(d).map((e) => e.event)
  assert.ok(evs.includes("STARTED"))
  assert.ok(evs.includes("PASSED"))
  const passed = events(d).find((e) => e.event === "PASSED")
  assert.equal(passed.exit, 0)
  assert.equal(existsSync(join(d, "t1.log")), false)
  const status = JSON.parse(readFileSync(join(d, "t1.status.json"), "utf8"))
  assert.equal(status.event, "PASSED")
})

test("FAILED: exit taşınır + log arşivlenir + banner", () => {
  const d = mktmp()
  const r = run([
    "--name", "t2", "--event-dir", d, "--heartbeat", "0", "--",
    NODE, "-e", "console.log('oops-error'); process.exit(3)",
  ])
  assert.equal(r.exit, 3)
  assert.ok(r.stdout.includes("<<< BUILD-MON [t2] FAILED"))
  const arch = ls(d).find((f) => /^t2\.log\.failed-\d{8}T\d{6}Z$/.test(f))
  assert.ok(arch, `arşiv yok: ${ls(d)}`)
  assert.ok(readFileSync(join(d, arch), "utf8").includes("oops-error"))
  const failed = events(d).find((e) => e.event === "FAILED")
  assert.equal(failed.exit, 3)
  assert.ok(failed.log.endsWith(`/${arch}`))
})

test("TIMED_OUT: exit 124 + timed_out arşivi", () => {
  const d = mktmp()
  const r = run(
    ["--name", "t7", "--event-dir", d, "--heartbeat", "0", "--timeout", "1",
      "--", ...sleepCmd(5000)],
    45000,
  )
  assert.equal(r.exit, 124)
  assert.ok(r.stdout.includes("TIMED_OUT"))
  assert.ok(ls(d).some((f) => /^t7\.log\.timed_out-/.test(f)))
}, { timeout: 60000 })

// Marj notu: stall tespiti ilk poll'da olur (~2s, POLL=2 sabit);
// 6sn uyku ~4s marj bırakır (önceki `sleep 3` yük altında flaky idi:
// tespit poll'u proses ölümünü ıskalayabiliyordu).
test("STALLED uyarısı sonra PASSED (ara-stall notuyla)", () => {
  const d = mktmp()
  const r = run(
    ["--name", "t4", "--event-dir", d, "--heartbeat", "0", "--stall-after", "1",
      "--", ...sleepCmd(6000)],
    45000,
  )
  assert.equal(r.exit, 0)
  const evs = events(d).map((e) => e.event)
  assert.ok(evs.includes("STALLED"))
  const passed = events(d).find((e) => e.event === "PASSED")
  assert.ok(passed.detail.includes("ara stall uyarısı vardı"))
}, { timeout: 60000 })

test("events boyut rotasyonu: arşiv + taze başlangıç", () => {
  const d = mktmp()
  writeFileSync(join(d, "events.jsonl"), "x".repeat(2000), "utf8")
  const r = run([
    "--name", "t3", "--event-dir", d, "--heartbeat", "0",
    "--rotate-size", "1000", "--", ...OK,
  ])
  assert.equal(r.exit, 0)
  assert.ok(ls(d).some((f) => /^events-\d{8}T\d{6}Z\.jsonl$/.test(f)))
  const evs = events(d).map((e) => e.event)
  assert.ok(evs.includes("STARTED"))
  assert.ok(evs.includes("PASSED"))
})

test("rotate-keep: eski arşivler budanır", () => {
  const d = mktmp()
  writeFileSync(join(d, "events.jsonl"), "old\n", "utf8")
  for (const n of ["20200101000000", "20210101000000", "20220101000000"]) {
    writeFileSync(join(d, `events-${n}Z.jsonl`), "a\n", "utf8")
  }
  const r = run([
    "--name", "t5", "--event-dir", d, "--heartbeat", "0",
    "--rotate-size", "1", "--rotate-keep", "2", "--", ...OK,
  ])
  assert.equal(r.exit, 0)
  const arch = ls(d).filter((f) => /^events-.*\.jsonl$/.test(f))
  assert.equal(arch.length, 2)
})

test("geçersiz flag değeri → exit 2", () => {
  const d = mktmp()
  const r = run(["--name", "t9", "--event-dir", d, "--rotate-size", "abc", "--", ...OK])
  assert.equal(r.exit, 2)
})

function waitFor(cond, timeoutMs, stepMs = 100) {
  const t0 = Date.now()
  return (async () => {
    for (;;) {
      const v = cond()
      if (v) return v
      if (Date.now() - t0 > timeoutMs) throw new Error("waitFor: zaman aşımı")
      await new Promise((r) => setTimeout(r, stepMs))
    }
  })()
}

test("--kill-on-stall: sessiz proses öldürülür, exit 111", () => {
  const d = mktmp()
  // 30sn uyku tespit+öldürme yolunu (~7s) her zaman hayatta atlatır;
  // zamanlayıcı marjı ~20s, deterministik.
  const r = run(
    ["--name", "tk", "--event-dir", d, "--heartbeat", "0",
      "--stall-after", "1", "--kill-on-stall", "--kill-grace", "1",
      "--", ...sleepCmd(30000)],
    60000,
  )
  assert.equal(r.exit, 111)
  assert.ok(r.stdout.includes("<<< BUILD-MON [tk] STALLED"))
  const stalled = events(d).filter((e) => e.event === "STALLED")
  assert.ok(stalled.length >= 1)
  const fatal = stalled.find((e) => e.exit === 111)
  assert.ok(fatal, "exit=111 STALLED finali yok")
  const status = JSON.parse(readFileSync(join(d, "tk.status.json"), "utf8"))
  assert.equal(status.event, "STALLED")
  assert.equal(status.exit, 111)
  assert.ok(ls(d).some((f) => /^tk\.log\.stalled-/.test(f)))
}, { timeout: 90000 })

test("INTERRUPTED: monitöre TERM → ağaç ölür, exit 143", async () => {
  const d = mktmp()
  const child = spawn(NODE,
    [SCRIPT, "--name", "ti", "--event-dir", d, "--heartbeat", "0", "--", ...sleepCmd(30000)],
    { cwd: ROOT })
  let stdout = ""
  child.stdout.on("data", (c) => { stdout += String(c) })
  child.stderr.on("data", (c) => { stdout += String(c) })
  const exitP = new Promise((resolve) => child.on("exit", resolve))
  try {
    // Monitör STARTED'ı yazıp watchdog'a girene kadar bekle (max 15s).
    const buildPid = await waitFor(() => {
      const m = stdout.match(/izleniyor \(pid=(\d+)\)/)
      return m ? Number(m[1]) : null
    }, 15000)
    child.kill("SIGTERM")
    const code = await Promise.race([
      exitP,
      new Promise((r) => setTimeout(() => r("timeout"), 20000)),
    ])
    assert.equal(code, 143)
    const evs = events(d).map((e) => e.event)
    assert.ok(evs.includes("STARTED"))
    assert.ok(evs.includes("INTERRUPTED"))
    assert.ok(ls(d).some((f) => /^ti\.log\.interrupted-/.test(f)))
    // Ağaç gerçekten öldü mü (TERM yarışına karşı deadline'lı bekle).
    await waitFor(() => {
      try { process.kill(buildPid, 0); return false }
      catch { return true }
    }, 5000)
  } finally {
    try { child.kill("SIGKILL") } catch { /* zaten çıkmış */ }
  }
}, { timeout: 90000 })
