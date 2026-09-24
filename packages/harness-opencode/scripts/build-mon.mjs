#!/usr/bin/env node
// scripts/build-mon.mjs — push/event build monitörü (Node portu, TASK-127).
//
// scripts/build-mon.sh'in birebir Node karşılığı: aynı argümanlar, aynı
// olay/dosya/banner sözleşmesi, aynı exit haritası. opencode-settle-noticer
// DEĞİŞMEDEN çalışır (final = `exit` alanlı status kuralı korunur).
//
// Neden port (2026-09-09, ölçüldü): bash/PATH-sınıfı 15 test Windows'ta
// çevresel sebeple fail (WSL-bash çözünürlüğü, `/usr/bin:/bin` override'u);
// tırnak taşıma yalnızca cmd/batch katmanında var. Node'da argv
// CreateProcess dizisiyle birebir taşınır. Davranış değişikliği YOK.
//
// Eşdeğerlik notları (bash → Node):
//   - `setsid "$@"` → `spawn(argv, { detached: true })` (unix'te setsid(2)).
//   - `kill -- -pgid` + `ps` fallback → `treeKill` (scripts/cpu-liveness-probe/
//     tree-kill.js; win32'de `taskkill /T /F`).
//   - `cpu_ticks` (/proc grup toplamı + `ps`) → `readTreeCpuTime`
//     (scripts/cpu-liveness-probe/cpu-liveness-probe.js; pid + canlı torunlar.
//     setsid/detached ağaç == grup olduğundan toplam aynı kümeyi ölçer.
//     win32'de powershell reader best-effort — bkz docs/build-mon.md Platform).
//   - `emit` içindeki python3 JSON kurulumu → JSON.stringify (python3 gereksinimi
//     kalktı — win32'de ayrıca değerli).
//   - `tail -F` canlı ayna → dosya-offset poll (250ms).
//   - `date -u +%FT%TZ` / `+%Y%m%dT%H%M%SZ` → aynı formatta JS üretimi.
//   - `kill -l` sinyal adı → SIGNAME tablosu.
//
// Kullanım (build-mon.sh ile aynı):
//   node scripts/build-mon.mjs [--name ID] [--event-dir DIR] [--stall-after SN]
//                [--kill-on-stall] [--kill-grace SN] [--timeout SN]
//                [--heartbeat SN] [--rotate-size BYTES] [--rotate-days N]
//                [--rotate-keep N] -- KOMUT [ARGS...]
//
// Çıkış kodları: derlemenin kodu aynen taşınır; 124=timeout ile öldürüldü,
//   111=stall sonrası öldürüldü, 130/143=monitör kesintiye uğradı,
//   127=komut başlatılamadı (bash'te tanımsızdı; Node'da spawn ENOENT'i
//   sessiz bırakmamak için ERROR + 127 — tek bilinçli ek).

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { treeKill } from "./cpu-liveness-probe/tree-kill.js";
import { readTreeCpuTime } from "./cpu-liveness-probe/cpu-liveness-probe.js";

const USAGE = `scripts/build-mon.mjs — push/event build monitörü (opencode-bm ile kullanım için).
Kullanım:
  build-mon.mjs [--name ID] [--event-dir DIR] [--stall-after SN]
                [--kill-on-stall] [--kill-grace SN] [--timeout SN]
                [--heartbeat SN] [--rotate-size BYTES] [--rotate-days N]
                [--rotate-keep N] -- KOMUT [ARGS...]
Olay dizini: --event-dir, yoksa $BUILD_MON_DIR, o da yoksa ./tmp/build-mon.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- argümanlar ---------------------------------------------------------------
let NAME = "build";
let EVENT_DIR = process.env.BUILD_MON_DIR || join(process.cwd(), "tmp", "build-mon");
let STALL_AFTER = 120;
let KILL_ON_STALL = 0;
let KILL_GRACE = 60;
let TIMEOUT = 0;
let HEARTBEAT = 60;
const POLL = 2;
let ROTATE_SIZE = 10485760;
let ROTATE_DAYS = 30;
let ROTATE_KEEP = 5;
let cmdArgs = [];

function usageFail(msg) {
  process.stderr.write(`build-mon: ${msg}\n${USAGE}\n`);
  process.exit(2);
}

{
  const argv = process.argv.slice(2);
  let i = 0;
  let sep = false;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!sep && a === "--") { sep = true; i++; break; }
    if (!sep && a === "--name") { NAME = argv[++i]; continue; }
    if (!sep && a === "--event-dir") { EVENT_DIR = argv[++i]; continue; }
    if (!sep && a === "--stall-after") { STALL_AFTER = argv[++i]; continue; }
    if (!sep && a === "--kill-on-stall") { KILL_ON_STALL = 1; continue; }
    if (!sep && a === "--kill-grace") { KILL_GRACE = argv[++i]; continue; }
    if (!sep && a === "--timeout") { TIMEOUT = argv[++i]; continue; }
    if (!sep && a === "--heartbeat") { HEARTBEAT = argv[++i]; continue; }
    if (!sep && a === "--rotate-size") { ROTATE_SIZE = argv[++i]; continue; }
    if (!sep && a === "--rotate-days") { ROTATE_DAYS = argv[++i]; continue; }
    if (!sep && a === "--rotate-keep") { ROTATE_KEEP = argv[++i]; continue; }
    if (!sep && (a === "-h" || a === "--help")) { process.stdout.write(USAGE + "\n"); process.exit(2); }
    if (!sep) usageFail(`bilinmeyen argüman: ${a}`);
    break;
  }
  cmdArgs = sep ? argv.slice(i) : [];
  if (cmdArgs.length === 0) usageFail("komut yok");
  const isNum = (v) => /^[0-9]+$/.test(String(v));
  // Doğrulama seti build-mon.sh ile aynı (KILL_GRACE/HEARTBEAT orada da
  // doğrulanmazdı — quirk birebir korunur).
  if (!isNum(STALL_AFTER)) usageFail("--stall-after sayı olmalı");
  if (!isNum(TIMEOUT)) usageFail("--timeout sayı olmalı");
  if (!isNum(ROTATE_SIZE)) usageFail("--rotate-size sayı olmalı");
  if (!isNum(ROTATE_DAYS)) usageFail("--rotate-days sayı olmalı");
  if (!isNum(ROTATE_KEEP)) usageFail("--rotate-keep sayı olmalı");
  STALL_AFTER = Number(STALL_AFTER);
  TIMEOUT = Number(TIMEOUT);
  ROTATE_SIZE = Number(ROTATE_SIZE);
  ROTATE_DAYS = Number(ROTATE_DAYS);
  ROTATE_KEEP = Number(ROTATE_KEEP);
  KILL_GRACE = Number(KILL_GRACE);
  HEARTBEAT = Number(HEARTBEAT);
}

mkdirSync(EVENT_DIR, { recursive: true });
if (!existsSync(join(EVENT_DIR, ".gitignore"))) {
  writeFileSync(join(EVENT_DIR, ".gitignore"), "*\n!.gitignore\n", "utf8");
}

// --- zaman formatı (bash `date -u` eşdeğeri) ----------------------------------
function utcTs() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
function utcStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

// --- rotasyon (TASK-122) -------------------------------------------------------
function rotateEvents() {
  const ev = join(EVENT_DIR, "events.jsonl");
  if (!existsSync(ev)) return;
  let doRot = false;
  if (ROTATE_SIZE > 0) {
    try {
      if (statSync(ev).size > ROTATE_SIZE) doRot = true;
    } catch { /* yok/okunamaz → rotasyonsuz devam */ }
  }
  if (!doRot && ROTATE_DAYS > 0) {
    try {
      const ageDays = (Date.now() - statSync(ev).mtimeMs) / 86400000;
      if (ageDays > ROTATE_DAYS) doRot = true;
    } catch { /* yut */ }
  }
  if (!doRot) return;
  const arch = join(EVENT_DIR, `events-${utcStamp()}.jsonl`);
  try {
    renameSync(ev, arch);
  } catch {
    return;
  }
  // keep: en yeni N arşiv tutulur (`ls -t` == mtime desc).
  try {
    const archs = readdirSync(EVENT_DIR)
      .filter((f) => /^events-.*\.jsonl$/.test(f))
      .map((f) => ({ f, m: statSync(join(EVENT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { f } of archs.slice(ROTATE_KEEP)) rmSync(join(EVENT_DIR, f), { force: true });
  } catch { /* yut */ }
}
rotateEvents();

let EVENTS = join(EVENT_DIR, "events.jsonl");
let STATUS = join(EVENT_DIR, `${NAME}.status.json`);
let RESULT = join(EVENT_DIR, `${NAME}.result`);
let LOG = join(EVENT_DIR, `${NAME}.log`);
writeFileSync(LOG, "", "utf8");

const CMD_STR = cmdArgs.join(" ");

// --- olay emisyonu -----------------------------------------------------------
function emit(ev, detail, code) {
  const ts = utcTs();
  const rec = { ts, name: NAME, event: ev, detail, log: LOG };
  if (code !== undefined && code !== null && code !== "") {
    rec.exit = Number.isInteger(code) ? code : String(code);
  }
  const line = JSON.stringify(rec);
  appendFileSync(EVENTS, line + "\n", "utf8");
  writeFileSync(STATUS, line + "\n", "utf8");
  writeFileSync(RESULT, `${ts} ${ev}: ${detail}\n`, "utf8");
}

function fisek(ev, msg) {
  process.stdout.write("\x07");
  process.stdout.write(`<<<\n<<< BUILD-MON [${NAME}] ${ev}: ${msg}\n<<<\n`);
  if (process.platform !== "win32") {
    try {
      spawnSync("notify-send", ["-u", "critical", `build-mon [${NAME}] ${ev}`, msg], {
        stdio: "ignore",
      });
    } catch { /* best-effort */ }
  }
}

function archiveLog(evLower) {
  const arch = join(EVENT_DIR, `${NAME}.log.${evLower}-${utcStamp()}`);
  try {
    renameSync(LOG, arch);
  } catch { /* yut */ }
  LOG = arch;
}

// --- process yardımcıları ------------------------------------------------------
function killTree(pid, signal) {
  return new Promise((resolve) => {
    try {
      treeKill(pid, signal, () => resolve());
    } catch {
      resolve();
    }
  });
}

function cpuTicks(pid, fallback) {
  try {
    const v = readTreeCpuTime(pid);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

// Sinyal tablosu (bash `kill -l` karşılığı; adlar SIG önekinden arındırılmış).
const SIGNO = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGABRT: 6, SIGFPE: 8,
  SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13,
  SIGALRM: 14, SIGTERM: 15,
};
const SIGNAME = Object.fromEntries(Object.entries(SIGNO).map(([k, v]) => [v, k.replace(/^SIG/, "")]));

// --- derlemeyi başlat (kendi process grubunda: setsid karşılığı detached) -----
const logFd = openSync(LOG, "w");
const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
  detached: true,
  stdio: ["ignore", logFd, logFd],
});
let spawnError = null;
child.on("error", () => { /* 'exit' üzerinden değil, bayrakla ele alınır */ });
await new Promise((r) => {
  child.on("spawn", r);
  child.on("error", (e) => { spawnError = e; r(); });
});
if (spawnError) {
  try { closeSync(logFd); } catch { /* yut */ }
  const detail = `komut başlatılamadı: ${spawnError.message} (${CMD_STR})`;
  emit("ERROR", detail, 127);
  fisek("ERROR", `${detail} (${NAME})`);
  process.exit(127);
}
// detached çocuk: grup lideri → pgid == pid (bash `ps -o pgid=` karşılığı).
const BUILD_PGID = child.pid;

const t0 = Date.now();
const elapsedSec = () => Math.floor((Date.now() - t0) / 1000);
let childExit = null;
const exited = new Promise((r) => child.on("exit", (code, signal) => { childExit = { code, signal }; r(); }));

emit("STARTED", `komut başladı (pid=${child.pid} pgid=${BUILD_PGID}): ${CMD_STR}`);
process.stdout.write(`build-mon [${NAME}]: izleniyor (pid=${child.pid}), log=${LOG}\n`);

// Canlı ayna (`tail -F` karşılığı): yeni baytları stdout'a akıt.
let mirrorOff = 0;
function mirrorTick() {
  try {
    const size = statSync(LOG).size;
    if (size < mirrorOff) mirrorOff = size;
    if (size > mirrorOff) {
      const fd = openSync(LOG, "r");
      try {
        const buf = Buffer.alloc(size - mirrorOff);
        readSync(fd, buf, 0, buf.length, mirrorOff);
        mirrorOff = size;
        process.stdout.write(buf);
      } finally {
        closeSync(fd);
      }
    }
  } catch { /* log silinmiş/taşınmış olabilir */ }
}
const mirrorTimer = setInterval(mirrorTick, 250);

// Kesinti: ağacı öldür, log'u arşivle, olayı yaz, 143 ile çık.
let interruptedFlag = false;
async function onInterrupt() {
  if (interruptedFlag) return;
  interruptedFlag = true;
  clearInterval(mirrorTimer);
  await killTree(child.pid, "SIGTERM");
  archiveLog("interrupted");
  emit("INTERRUPTED", "monitör kesintiye uğradı, derleme ağacı öldürüldü");
  fisek("INTERRUPTED", `monitör kesintiye uğradı (${NAME})`);
  process.exit(143);
}
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);

// Hızlı biten çocuk (`true`) için 'exit' olayının watchdog'a girmeden
// işlenmesine fırsat ver (yoksa ilk POLL uykusu gereksiz 2sn ekler).
await new Promise((r) => setImmediate(r));

// --- watchdog -----------------------------------------------------------------
let lastSize = 0;
let lastCpu = cpuTicks(child.pid, 0);
let silent = 0;
let stalledFlag = false;
let stalledBefore = false;
let lastHb = 0;
let killedBy = "";

while (child.exitCode === null && !interruptedFlag) {
  await sleep(POLL * 1000);
  if (child.exitCode !== null || interruptedFlag) break;
  const elapsed = elapsedSec();

  if (TIMEOUT > 0 && elapsed >= TIMEOUT) {
    killedBy = "timeout";
    await killTree(child.pid, "SIGTERM");
    await sleep(3000);
    await killTree(child.pid, "SIGKILL");
    break;
  }

  let size = 0;
  try {
    size = statSync(LOG).size;
  } catch { /* yut */ }
  const cpu = cpuTicks(child.pid, 0);
  if (size === lastSize && cpu === lastCpu) {
    silent += POLL;
  } else {
    silent = 0;
    lastSize = size;
    lastCpu = cpu;
  }

  if (silent >= STALL_AFTER && !stalledFlag) {
    stalledFlag = true;
    stalledBefore = true;
    emit("STALLED", `asılı şüphesi: ${silent}sn çıktı+CPU sessizliği (pid=${child.pid})`);
    fisek("STALLED", `asılı şüphesi (${NAME}): ${silent}sn sessiz`);
  }
  if (KILL_ON_STALL === 1 && stalledFlag && silent >= STALL_AFTER + KILL_GRACE) {
    killedBy = "stall";
    await killTree(child.pid, "SIGTERM");
    await sleep(3000);
    await killTree(child.pid, "SIGKILL");
    break;
  }

  if (HEARTBEAT > 0 && elapsed - lastHb >= HEARTBEAT) {
    lastHb = elapsed;
    let lines = 0;
    try {
      lines = readFileSync(LOG, "utf8").split("\n").length - 1;
    } catch { /* yut */ }
    emit("HEARTBEAT", `${elapsed}sn geçti, log=${lines} satır, cpu=${cpu} tick, sessizlik=${silent}sn`);
  }
}

clearInterval(mirrorTimer);
mirrorTick();
await sleep(300);

// --- final sınıflandırma -------------------------------------------------------
if (killedBy === "timeout") {
  await exited;
  archiveLog("timed_out");
  emit("TIMED_OUT", `tavan aşıldı (${TIMEOUT}sn), ağaç öldürüldü`);
  fisek("TIMED_OUT", `tavan aşıldı (${NAME}, ${TIMEOUT}sn)`);
  process.exit(124);
}

if (killedBy === "stall") {
  await exited;
  archiveLog("stalled");
  emit("STALLED", `asılı kaldı (${silent}sn sessizlik), --kill-on-stall ile öldürüldü`, 111);
  fisek("STALLED", `asılı kaldı, öldürüldü (${NAME})`);
  process.exit(111);
}

await exited;
const CODE = childExit.code !== null && childExit.code !== undefined
  ? childExit.code
  : 128 + (SIGNO[childExit.signal] ?? 0);
const elapsed = elapsedSec();

if (CODE === 0) {
  let detail = `derleme geçti (${elapsed}sn)`;
  if (stalledBefore) detail += " [ara stall uyarısı vardı]";
  rmSync(LOG, { force: true });
  emit("PASSED", detail, 0);
  fisek("PASSED", `${detail} (${NAME})`);
  process.exit(0);
}

if (CODE > 128) {
  const sig = CODE - 128;
  const signame = SIGNAME[sig] ?? String(sig);
  archiveLog("error");
  emit("ERROR", `proses sinyal ile öldü: SIG${signame} (exit=${CODE}, ${elapsed}sn)`, CODE);
  fisek("ERROR", `sinyal ile öldü: SIG${signame} (${NAME})`);
  process.exit(CODE);
}

// Dil/ecosystem bazlı FAILED kanıtı (build-mon.sh FAIL_SIG seti birebir).
const FAIL_SRC =
  "test result: FAILED|FAILED|panicked|failures:|error\\[E[0-9]+|npm ERR!|error TS[0-9]+|^FAIL\\b|^FAIL:|--- FAIL:|make.*\\*\\*\\* |go: .* failed";
const HINT_SRC = "^[ \\t\\r\\f\\v]*error:|^[ \\t\\r\\f\\v]*error\\b";
const failLine = new RegExp(FAIL_SRC, "i");
const hintLine = new RegExp(HINT_SRC, "i");
const failAny = new RegExp(FAIL_SRC, "im");

let logContent = "";
try {
  logContent = readFileSync(LOG, "utf8");
} catch { /* yut */ }
let contentLines = logContent.split("\n");
if (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") contentLines.pop();
const hits = contentLines.filter((l) => failLine.test(l) || hintLine.test(l)).slice(0, 8);
let excerpt = hits.length > 0 ? hits.join("|") + "|" : "";
if (!excerpt) {
  const tail = contentLines.slice(-5);
  excerpt = tail.length > 0 ? tail.join("|") + "|" : "";
}
let detail;
if (failAny.test(logContent)) {
  detail = `testler/derleme KIRILDI (exit=${CODE}, ${elapsed}sn) :: ${excerpt.slice(0, 400)}`;
} else {
  detail = `derleme hatayla bitti (exit=${CODE}, ${elapsed}sn) :: ${excerpt.slice(0, 400)}`;
}
if (stalledBefore) detail += " [ara stall uyarısı vardı]";
archiveLog("failed");
emit("FAILED", detail, CODE);
fisek("FAILED", `${detail} (${NAME})`);
process.exit(CODE);
