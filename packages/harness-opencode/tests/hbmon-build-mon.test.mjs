/**
 * Regression tests for scripts/hbmon-build-mon.mjs
 * (TASK-004: build-mon sözleşmesi, hbmon motoru; TASK-127: Node portu).
 *
 * Strateji: gerçek hbmon ikiliği yoksa bile çalışan fake-hbmon
 * (doğrudan `process.execPath` ile koşturulan Node scripti — `.cmd`
 * taşıyıcı, PATH override'u, bash shim'i yok) ile olay haritalama
 * deterministik test edilir; gerçek ikilik testleri HBMON_LIVE=1 ile
 * kapılıdır (opencode-plugins CI'da hbmon derlenmez).
 *
 * Adapter `HBMON_BIN` `.mjs` ile bittiğinde onu `process.execPath`
 * ile spawn eder; bu sayede fake win32+unix'te aynı çalışır (tırnak
 * taşıma yok — argv CreateProcess dizisiyle birebir taşınır).
 */

import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join, dirname } from "node:path"

const SCRIPT = fileURLToPath(new URL("../scripts/hbmon-build-mon.mjs", import.meta.url))
const ROOT = dirname(dirname(fileURLToPath(new URL(".", import.meta.url))))
const NODE = process.execPath
const LIVE = !!process.env.HBMON_LIVE

// fake hbmon (Node): watch=handshake, wait=sıradaki yanıt, kill/shutdown=ok.
// Adapter HBMON_BIN'i .mjs uzantısından tanıyıp process.execPath ile
// spawn eder — taşıyıcı script yok.
const FAKE_MJS = `
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
const [cmd] = process.argv.slice(2)
const uuid = process.env.FAKE_UUID ?? "x"
const seqDir = process.env.FAKE_SEQ_DIR ?? ""
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
if (cmd === "--version") {
  out({ v: 1, bin: "fake-hbmon" })
} else if (cmd === "watch") {
  out({ v: 1, ev: "ready", uuid, sock: \`sock-\${uuid}\`, log: \`log-\${uuid}\` })
} else if (cmd === "wait") {
  const files = existsSync(seqDir)
    ? readdirSync(seqDir).filter((f) => /^\\d+\\.json$/.test(f)).sort()
    : []
  let i = parseInt(String(readFileSync(join(seqDir, "idx"), "utf8")).trim() || "0", 10)
  if (i >= files.length) i = files.length - 1
  process.stdout.write(readFileSync(join(seqDir, files[i]), "utf8"))
  writeFileSync(join(seqDir, "idx"), String(i + 1))
} else if (cmd === "kill") {
  out({ v: 1, ok: true, killed: true })
} else if (cmd === "shutdown") {
  out({ v: 1, ok: true, ok_shutdown: true })
}
process.exit(0)
`

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hbm-test-"))
}

function fakeEnv(d, uuid) {
  const bin = join(d, "bin")
  mkdirSync(bin, { recursive: true })
  const fake = join(bin, "hbmon.mjs")
  writeFileSync(fake, FAKE_MJS)
  const seq = join(d, "seq")
  mkdirSync(seq, { recursive: true })
  writeFileSync(join(seq, "idx"), "0")
  return {
    ...process.env,
    HBMON_BIN: fake,
    FAKE_UUID: uuid,
    FAKE_SEQ_DIR: seq,
  }
}

function hbmonOut(uuid) {
  return join(tmpdir(), `hbmon-${uuid}.out`)
}

function seq(env, responses) {
  responses.forEach((r, i) =>
    writeFileSync(join(env.FAKE_SEQ_DIR, `${i}.json`), JSON.stringify(r)),
  )
}

function run(args, env, execTimeout = 30000) {
  return new Promise((resolve) => {
    execFile(
      NODE,
      [SCRIPT, ...args],
      { encoding: "utf8", timeout: execTimeout, cwd: ROOT, env },
      (err, stdout, stderr) => {
        resolve({
          exit: err && typeof err.code === "number" ? err.code : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        })
      },
    )
  })
}

function events(dir) {
  const raw = readFileSync(join(dir, "events.jsonl"), "utf8").trim()
  return raw.length === 0 ? [] : raw.split("\n").map((l) => JSON.parse(l))
}

const DONE0 = {
  v: 1, id: "x", ok: true, state: "done", code: 0, duration_sec: 1.2,
  exit_event: { code: 0, raw_code: 0, state: "done" },
}
const FAILED1 = {
  v: 1, id: "x", ok: true, state: "failed", code: 1, duration_sec: 1.0,
  exit_event: { code: 1, raw_code: 1, state: "failed" },
}
const STALL = { v: 1, id: "x", ok: true, state: "running", elapsed_sec: 31.0, woke_on: "stall_suspect" }
const DEP_EARLY = { v: 1, id: "x", ok: true, state: "running", woke_on: "dep_missing" }
const DEP_TERM = {
  v: 1, id: "x", ok: true, state: "dep_missing", code: 2, duration_sec: 3.0,
  exit_event: { code: 2, raw_code: 1, state: "dep_missing" },
}

test("PASSED: exit 0 + banner + status exit alanı (fake)", async () => {
  const d = mktmp()
  const env = fakeEnv(d, "shimpass1")
  seq(env, [DONE0])
  const r = await run(["--name", "p1", "--event-dir", d, "--", NODE, "-e", ""], env)
  assert.equal(r.exit, 0)
  assert.ok(r.stdout.includes("<<< BUILD-MON [p1] PASSED"))
  const evs = events(d).map((e) => e.event)
  assert.ok(evs.includes("STARTED"))
  assert.ok(evs.includes("PASSED"))
  const st = JSON.parse(readFileSync(join(d, "p1.status.json"), "utf8"))
  assert.equal(st.exit, 0)
})

test("FAILED: excerpt + exit kodu taşınır (fake)", async () => {
  const d = mktmp()
  const env = fakeEnv(d, "shimfail1")
  writeFileSync(hbmonOut("shimfail1"), "blah\nerror TS1234: nope\nblah\n")
  seq(env, [FAILED1])
  const r = await run(["--name", "f1", "--event-dir", d, "--", NODE, "-e", ""], env)
  assert.equal(r.exit, 1)
  assert.ok(r.stdout.includes("TS1234"), `excerpt yok: ${r.stdout}`)
  const st = JSON.parse(readFileSync(join(d, "f1.status.json"), "utf8"))
  assert.equal(st.event, "FAILED")
  assert.equal(st.exit, 1)
})

test("<name>.log: settle'da .out kopyası alınır (fake)", async () => {
  const d = mktmp()
  const env = fakeEnv(d, "shimlog1")
  writeFileSync(hbmonOut("shimlog1"), "HI\nERR\n")
  seq(env, [DONE0])
  const r = await run(["--name", "l1", "--event-dir", d, "--", NODE, "-e", ""], env)
  assert.equal(r.exit, 0)
  assert.equal(readFileSync(join(d, "l1.log"), "utf8"), "HI\nERR\n")
})

test("STALLED uyarısı bir kez + sonra PASSED (fake)", async () => {
  const d = mktmp()
  const env = fakeEnv(d, "shimstall1")
  seq(env, [STALL, STALL, DONE0])
  const r = await run(["--name", "s1", "--event-dir", d, "--", NODE, "-e", ""], env)
  assert.equal(r.exit, 0)
  const evs = events(d).map((e) => e.event)
  assert.equal(evs.filter((e) => e === "STALLED").length, 1)
  assert.equal(evs[evs.length - 1], "PASSED")
})

test("DEP_MISSING erken uyarı + terminal FAILED/2 (fake)", async () => {
  const d = mktmp()
  const env = fakeEnv(d, "shimdep1")
  writeFileSync(hbmonOut("shimdep1"), "Cannot find module 'x'\n")
  seq(env, [DEP_EARLY, DEP_EARLY, DEP_TERM])
  const r = await run(["--name", "m1", "--event-dir", d, "--", NODE, "-e", ""], env)
  assert.equal(r.exit, 2)
  const evs = events(d).map((e) => e.event)
  assert.equal(evs.filter((e) => e === "DEP_MISSING").length, 1)
  assert.equal(evs[evs.length - 1], "FAILED")
})

test("hbmon yoksa exit 2 + kurulum ipucu", async () => {
  const d = mktmp()
  // PATH override'u yok (TASK-127: win32'de `/usr/bin:/bin` yok) —
  // bulunamayan HBMON_BIN tek başına exit 2 üretmeli.
  const env = { ...process.env, HBMON_BIN: "/nonexistent-xyz/hbmon" }
  delete env.FAKE_UUID
  delete env.FAKE_SEQ_DIR
  const r = await run(["--name", "n1", "--event-dir", d, "--", NODE, "-e", ""], env, 10000)
  assert.equal(r.exit, 2)
  assert.ok((r.stderr + r.stdout).includes("cargo install"))
})

test("CANLI PASSED (gerçek hbmon)", { skip: !LIVE }, async () => {
  const d = mktmp()
  const r = await run(
    ["--name", "lp1", "--event-dir", d, "--", NODE, "-e", ""],
    { ...process.env, HBMON_BIN: process.env.HBMON_BIN || "hbmon" },
  )
  assert.equal(r.exit, 0)
  const st = JSON.parse(readFileSync(join(d, "lp1.status.json"), "utf8"))
  assert.equal(st.exit, 0)
})

test("CANLI FAILED excerpt (gerçek hbmon)", { skip: !LIVE }, async () => {
  const d = mktmp()
  const env = { ...process.env, HBMON_BIN: process.env.HBMON_BIN || "hbmon" }
  const r = await run(
    ["--name", "lf1", "--event-dir", d, "--",
      NODE, "-e", "console.error('error TS9999: boom'); process.exit(1)"],
    env,
    60000,
  )
  assert.equal(r.exit, 1)
  assert.ok(r.stdout.includes("TS9999"))
})
