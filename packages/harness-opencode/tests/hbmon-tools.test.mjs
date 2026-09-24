/**
 * Tests for opencode-hbmon custom tools (TASK-126).
 *
 * Strateji: fake-hbmon (node --import preload, gerçek .exe zinciri,
 * shell yok) ile kontrat deterministik test edilir; gerçek ikilik
 * testleri HBMON_LIVE=1 ile kapılıdır (opencode-plugins CI'da hbmon
 * derlenmez). Lib `../dist` üzerinden import edilir (pretest: npm run build).
 */

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  HBMON_INSTALL_HINT,
  resolveHbmonBin,
  runHbmon,
  statusBuild,
  summarizeWait,
  waitBuild,
  watchBuild,
} from "nabiz-core/hbmon-tools"
import hbmonFactory from "../dist/plugins/opencode-hbmon.js"

const LIVE = !!process.env.HBMON_LIVE

// fake hbmon: win32'de .cmd taşıyıcı + .mjs mantık, unix'te bash
// taşıyıcı + aynı .mjs (lib gerçek .exe zinciriyle spawn eder; shell
// yok). %n tırnakları korur, shift /1 %0'ı korur, %~1 ile karşılaştırılır.
// Boş ("") ve % içeren argüman desteklenmez (test argv'sinde yok).
// watch=handshake, wait/status=sıradaki yanıt, kill/shutdown=ok.
const FAKE_MJS = `
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
const [cmd] = process.argv.slice(2)
const uuid = process.env.FAKE_UUID ?? "x"
const seqDir = process.env.FAKE_SEQ_DIR ?? ""
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
// Bağlantı-yarışı simülasyonu: ilk N çağrı "pipe yok" hatası verir.
const failFile = join(seqDir, "failfirst")
if (existsSync(failFile)) {
  const left = parseInt(String(readFileSync(failFile, "utf8")).trim() || "0", 10)
  if (left > 0) {
    writeFileSync(failFile, String(left - 1))
    process.stderr.write("hbmon: pipe wait sock: 2\\n")
    process.exit(3)
  }
}
if (process.env.FAKE_ARGV_FILE) {
  writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2)))
}
if (cmd === "watch") {
  out({ v: 1, ev: "ready", uuid, sock: \`sock-\${uuid}\`, log: \`log-\${uuid}\` })
} else if (cmd === "wait" || cmd === "status") {
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
const SHIM_SH = `#!/usr/bin/env bash
exec node "$(dirname "$0")/hbmon.mjs" "$@"
`
const SHIM_CMD = `@echo off
set "NODECMD="
:loop
if "%~1"=="" goto run
set "NODECMD=%NODECMD% %1"
shift /1
goto loop
:run
node "%~dp0hbmon.mjs" %NODECMD%
`

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hbmon-tool-test-"))
}

function shimBin(t, uuid) {
  const bin = join(t, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, "hbmon.mjs"), FAKE_MJS)
  const launcher = process.platform === "win32" ? "hbmon.cmd" : "hbmon"
  writeFileSync(join(bin, launcher), process.platform === "win32" ? SHIM_CMD : SHIM_SH)
  chmodSync(join(bin, launcher), 0o755)
  const seq = join(t, "seq")
  mkdirSync(seq, { recursive: true })
  writeFileSync(join(seq, "idx"), "0")
  return {
    bin: join(bin, launcher),
    seq,
    env: { FAKE_UUID: uuid, FAKE_SEQ_DIR: seq },
  }
}

function seq(s, responses) {
  responses.forEach((r, i) =>
    writeFileSync(join(s.seq, `${i}.json`), JSON.stringify(r)),
  )
}

const DONE = { v: 1, id: "x", ok: true, state: "done", code: 0, duration_sec: 38.5 }
const DEP_EARLY = { v: 1, id: "x", ok: true, state: "running", woke_on: "dep_missing" }
const TIMEOUT = { v: 1, id: "x", ok: true, state: "running", timeout: true, woke_on: "timeout" }
const STATUS = { v: 1, id: "x", ok: true, state: "running", uuid: "u1" }

function fullEnv(s) {
  return { ...process.env, ...s.env }
}

test("resolveHbmonBin: HBMON_BIN > PATH", () => {
  assert.equal(resolveHbmonBin({ HBMON_BIN: "/yol/hbmon" }), "/yol/hbmon")
  assert.equal(resolveHbmonBin({ HBMON_BIN: "  " }), "hbmon")
  assert.equal(resolveHbmonBin({}), "hbmon")
})

test("ikilik yoksa kurulum ipucu (öldürmez)", async () => {
  const r = await runHbmon("/nonexistent-xyz/hbmon", ["status"], 5000)
  assert.equal(r.code, 127)
  assert.ok((r.error ?? "").includes("cargo install"))
  assert.ok(HBMON_INSTALL_HINT.includes("cargo install"))
})

test("watch: handshake parse", async () => {
  const t = mktmp()
  const s = shimBin(t, "w1")
  const w = await watchBuild(s.bin, ["cargo", "build"], { env: fullEnv(s) })
  assert.ok(!w.error, w.error)
  assert.equal(w.handshake.uuid, "w1")
  assert.equal(w.handshake.sock, "sock-w1")
  assert.equal(w.handshake.log, "log-w1")
})

test("wait: erken-dönüş + terminal özeti", async () => {
  const t = mktmp()
  const s = shimBin(t, "w2")
  seq(s, [DEP_EARLY, DONE])
  const first = await waitBuild(s.bin, "sock-w2", { timeoutSec: 50, until: "dep_missing,done", env: fullEnv(s) })
  assert.ok(!first.error, first.error)
  assert.equal(first.summary, "woke_on=dep_missing state=running — hbmon_status ile detaya bak")
  const second = await waitBuild(s.bin, "sock-w2", { timeoutSec: 50, env: fullEnv(s) })
  assert.equal(second.summary, "done code=0 in 38.5s")
})

test("wait: timeout (hâlâ çalışıyor)", async () => {
  const t = mktmp()
  const s = shimBin(t, "w3")
  seq(s, [TIMEOUT])
  const w = await waitBuild(s.bin, "sock-w3", { timeoutSec: 50, env: fullEnv(s) })
  assert.ok(w.summary.startsWith("timeout (hâlâ çalışıyor)"))
})

test("status: passthrough", async () => {
  const t = mktmp()
  const s = shimBin(t, "w4")
  seq(s, [STATUS])
  const r = await statusBuild(s.bin, "sock-w4", fullEnv(s))
  assert.ok(!r.error, r.error)
  assert.equal(r.response.state, "running")
})

test("summarizeWait: durum cümleleri", () => {
  assert.equal(
    summarizeWait({ state: "dep_missing", code: 2, duration_sec: 3.0 }, 2),
    "dep_missing (exit 2) in 3.0s — log'a bak, bitmesini bekleme",
  )
  assert.equal(summarizeWait({ state: "failed", code: 1 }, 1), "failed code=1")
  assert.equal(summarizeWait({ state: "stalled", woke_on: "stall_suspect" }, 0), "woke_on=stall_suspect state=stalled — hbmon_status ile detaya bak")
})

test("plugin: default export + 3 tool + kapalı-modu", async () => {
  assert.equal(typeof hbmonFactory, "function")
  const inst = await hbmonFactory({ directory: "/tmp" }, {})
  for (const name of ["hbmon_watch", "hbmon_wait", "hbmon_status"]) {
    assert.equal(typeof inst.tool[name].execute, "function", `${name} execute`)
  }
  const off = await hbmonFactory({ directory: "/tmp" }, { enabled: false })
  assert.ok((await off.tool.hbmon_wait.execute({ sock: "x" }, {})).includes("kapalı"))
})

test("plugin tool: hbmon_wait uçtan uca (shim)", async () => {
  const t = mktmp()
  const s = shimBin(t, "w5")
  seq(s, [DONE])
  const prevBin = process.env.HBMON_BIN
  const prevUuid = process.env.FAKE_UUID
  const prevSeq = process.env.FAKE_SEQ_DIR
  process.env.HBMON_BIN = s.bin
  process.env.FAKE_UUID = s.env.FAKE_UUID
  process.env.FAKE_SEQ_DIR = s.env.FAKE_SEQ_DIR
  try {
    const inst = await hbmonFactory({ directory: "/tmp" }, {})
    const out = await inst.tool.hbmon_wait.execute({ sock: "sock-w5" }, {})
    assert.ok(out.startsWith("done code=0 in 38.5s"), out.split("\n")[0])
    assert.ok(out.includes('"state":"done"'))
  } finally {
    if (prevBin === undefined) delete process.env.HBMON_BIN
    else process.env.HBMON_BIN = prevBin
    if (prevUuid === undefined) delete process.env.FAKE_UUID
    else process.env.FAKE_UUID = prevUuid
    if (prevSeq === undefined) delete process.env.FAKE_SEQ_DIR
    else process.env.FAKE_SEQ_DIR = prevSeq
  }
})

test("boşluklu argv bütün gelir (gerçek .exe zinciri)", async () => {
  const t = mktmp()
  const s = shimBin(t, "w6")
  const argvFile = join(t, "argv.json")
  const env = { ...fullEnv(s), FAKE_ARGV_FILE: argvFile }
  const w = await watchBuild(s.bin, ["powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 1"], { env })
  assert.ok(w.handshake, w.error)
  const got = JSON.parse(readFileSync(argvFile, "utf8"))
  assert.deepEqual(got, ["watch", "--detach", "--", "powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 1"])
})

test("startup yarışı: bağlantı hatasında retry", async () => {
  const t = mktmp()
  const s = shimBin(t, "w7")
  seq(s, [DONE])
  writeFileSync(join(s.seq, "failfirst"), "3")
  const w = await waitBuild(s.bin, "sock-w7", { timeoutSec: 50, env: fullEnv(s), startupGraceMs: 8000 })
  assert.ok(!w.error, w.error)
  assert.equal(w.summary, "done code=0 in 38.5s")
})

test("CANLI watch+wait (gerçek hbmon)", { skip: !LIVE }, async () => {
  const bin = resolveHbmonBin()
  const w = await watchBuild(bin, ["echo", "hi"])
  assert.ok(w.handshake, w.error)
  const r = await waitBuild(bin, w.handshake.sock, { timeoutSec: 30 })
  assert.ok(!r.error, r.error)
  assert.match(r.summary, /^done code=0/)
})
