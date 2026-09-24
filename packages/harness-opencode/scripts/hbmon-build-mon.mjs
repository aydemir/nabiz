#!/usr/bin/env node
// scripts/hbmon-build-mon.mjs — build-mon sözleşmesi, hbmon motoru (Node portu, TASK-127).
//
// scripts/hbmon-build-mon.sh'in birebir Node karşılığı: aynı argümanlar, aynı
// olay/dosya/banner sözleşmesi, aynı exit haritası. opencode-settle-noticer
// DEĞİŞMEDEN çalışır (final = `exit` alanlı status kuralı korunur).
//
// build-mon.sh farkları (.sh'ten devralınan bilinçli farklar, değişmedi):
//   - Stall eşiği sabit değil, hbmon'un adaptif eşiği (3×p95, min 30s).
//   - Derleme çıktısı hbmon'un .out'unda yaşar; settle anında kopyası
//     tmp/build-mon/<name>.log'a alınır (hbmon cleanup .out'u silebilir).
//   - OOM ve dep-missing first-class olaylar (build-mon'da yoktu).
//   - Rotasyon hbmon tarafında (JSONL 100MB FIFO cap).
//
// Eşdeğerlik notları (bash → Node):
//   - hbmon çağrıları `shell: false` spawnSync ile (argv dizisi CreateProcess'e
//     birebir taşınır — win32'de `%*`/`%~1` tırnak taşıma sorunu yok).
//   - `HBMON_BIN` `.mjs`/`.cjs`/`.js` ile biterse `process.execPath` ile
//     çalıştırılır (Node fake'leriyle test kancası; gerçek hbmon ikiliklerinde
//     davranış aynı). Diğer değerler doğrudan spawn edilir.
//   - `emit` içindeki python3 JSON kurulumu → JSON.stringify (python3
//     gereksinimi kalktı); `mktemp` → `os.tmpdir()` altında sabit ad
//     (iç durum bellekte tutulur, temp dosya yok).
//   - hbmon `.out` yolu: `os.tmpdir()/hbmon-<uuid>.out` (unix'te `/tmp` ile aynı).
//   - `kill -l` sinyal adı → SIGNAME tablosu.
//
// Kullanım (hbmon-build-mon.sh ile aynı):
//   node scripts/hbmon-build-mon.mjs [--name ID] [--event-dir DIR] [--timeout SN]
//       [--kill-on-stall] [--kill-grace SN] [--until LIST] -- KOMUT [ARGS...]
//
// Gereksinim: hbmon ikiliği (HBMON_BIN env veya PATH).
//   cargo install hbmon
//
// Çıkış kodları build-mon.sh ile aynı: 0 | derleme kodu | 124 timeout |
//   111 stall-kill | 143 kesinti (+137 OOM).

import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const USAGE = `scripts/hbmon-build-mon.mjs — build-mon sözleşmesi, hbmon motoru.
Kullanım:
  hbmon-build-mon.mjs [--name ID] [--event-dir DIR] [--timeout SN]
      [--kill-on-stall] [--kill-grace SN] [--until LIST] -- KOMUT [ARGS...]
Gereksinim: hbmon ikiliği (HBMON_BIN env veya PATH).`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- argümanlar ---------------------------------------------------------------
let NAME = "build";
let EVENT_DIR = process.env.BUILD_MON_DIR || join(process.cwd(), "tmp", "build-mon");
let TIMEOUT = 0;
let KILL_ON_STALL = 0;
let KILL_GRACE = 60;
let UNTIL = "done,failed,dep_missing,stall_suspect,oom_suspect,timeout";
let HBMON = process.env.HBMON_BIN || "hbmon";
let cmdArgs = [];

function usageFail(msg) {
  process.stderr.write(`hbmon-build-mon: ${msg}\n${USAGE}\n`);
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
    if (!sep && a === "--timeout") { TIMEOUT = argv[++i]; continue; }
    if (!sep && a === "--kill-on-stall") { KILL_ON_STALL = 1; continue; }
    if (!sep && a === "--kill-grace") { KILL_GRACE = argv[++i]; continue; }
    if (!sep && a === "--until") { UNTIL = argv[++i]; continue; }
    if (!sep && (a === "-h" || a === "--help")) { process.stdout.write(USAGE + "\n"); process.exit(2); }
    if (!sep) usageFail(`bilinmeyen argüman: ${a}`);
    break;
  }
  cmdArgs = sep ? argv.slice(i) : [];
  if (cmdArgs.length === 0) usageFail("komut yok");
  const isNum = (v) => /^[0-9]+$/.test(String(v));
  if (!isNum(TIMEOUT)) usageFail("--timeout sayı olmalı");
  if (!isNum(KILL_GRACE)) usageFail("--kill-grace sayı olmalı");
  TIMEOUT = Number(TIMEOUT);
  KILL_GRACE = Number(KILL_GRACE);
}

// --- hbmon çalıştırma (shell yok, argv dizisi) --------------------------------
function hbmonBase() {
  if (/\.m?js$|\.cjs$/.test(HBMON)) return [process.execPath, HBMON];
  return [HBMON];
}

function hbmonRun(args, timeoutMs) {
  const base = hbmonBase();
  try {
    const res = spawnSync(base[0], [...base.slice(1), ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
    });
    return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? -1, error: res.error };
  } catch (e) {
    return { stdout: "", stderr: "", code: -1, error: e };
  }
}

function hbmonMissing() {
  // Varlık kontrolü (bash `command -v` karşılığı): salt-okunur prob.
  const probe = hbmonRun(["--version"], 10000);
  return !!probe.error;
}

if (!HBMON || hbmonMissing()) {
  process.stderr.write(`hbmon-build-mon: hbmon bulunamadı (HBMON_BIN=${HBMON})\n`);
  process.stderr.write("  cargo install hbmon\n");
  process.exit(2);
}

mkdirSync(EVENT_DIR, { recursive: true });
if (!existsSync(join(EVENT_DIR, ".gitignore"))) {
  writeFileSync(join(EVENT_DIR, ".gitignore"), "*\n!.gitignore\n", "utf8");
}

const EVENTS = join(EVENT_DIR, "events.jsonl");
const STATUS = join(EVENT_DIR, `${NAME}.status.json`);
const RESULT = join(EVENT_DIR, `${NAME}.result`);

function utcTs() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function emit(ev, detail, code) {
  const ts = utcTs();
  const rec = { ts, name: NAME, event: ev, detail, log: HBOUT };
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

// build-mon.sh'in FAILED kanıt seti (aynı — excerpt tutarlılığı için).
const FAIL_SRC =
  "test result: FAILED|FAILED|panicked|failures:|error\\[E[0-9]+|npm ERR!|error TS[0-9]+|^FAIL\\b|^FAIL:|--- FAIL:|make.*\\*\\*\\* |go: .* failed";
const failLine = new RegExp(FAIL_SRC, "i");

function excerptOf(f) {
  let content = "";
  try {
    content = readFileSync(f, "utf8");
  } catch {
    return "";
  }
  let lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const hits = lines.filter((l) => failLine.test(l)).slice(0, 8);
  const ex = hits.length > 0 ? hits.join("|") + "|" : lines.slice(-5).join("|") + (lines.length > 0 ? "|" : "");
  return ex.slice(0, 400);
}

// Settle anında hbmon .out'unun kopyasını <name>.log'a al (best-effort,
// sessiz: .out yoksa/okunamazsa eski davranış korunur).
function syncBuildLog() {
  try {
    if (HBOUT === "") return;
    copyFileSync(HBOUT, join(EVENT_DIR, `${NAME}.log`));
  } catch { /* sessiz geç */ }
}

const SIGNO = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGABRT: 6, SIGFPE: 8,
  SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13,
  SIGALRM: 14, SIGTERM: 15,
};
const SIGNAME = Object.fromEntries(Object.entries(SIGNO).map(([k, v]) => [v, k.replace(/^SIG/, "")]));

// --- spawn (hbmon daemon) ------------------------------------------------------
const tflag = TIMEOUT > 0 ? ["--timeout-sec", String(TIMEOUT)] : [];
const hs = hbmonRun(["watch", "--detach", ...tflag, "--", ...cmdArgs], 30000);
let UUID = "";
let SOCK = "";
try {
  const parsed = JSON.parse(String(hs.stdout).trim());
  UUID = parsed.uuid ?? "";
  SOCK = parsed.sock ?? "";
} catch { /* aşağıda ele alınır */ }
if (!UUID) {
  process.stderr.write(`hbmon-build-mon: spawn başarısız (çıktı: ${hs.stdout})`);
  process.exit(3);
}
// .out yolu: hbmon'un uuid-convention'ı (tmpdir/hbmon-<uuid>.out).
// Handshake'teki `log` JSONL yoludur, build çıktısı değildir — karıştırma.
const HBOUT = join(tmpdir(), `hbmon-${UUID}.out`);
const CMD_STR = cmdArgs.join(" ");
const t0 = Date.now();
const elapsedSec = () => Math.floor((Date.now() - t0) / 1000);

emit("STARTED", `komut başladı (hbmon uuid=${UUID}): ${CMD_STR}`);
process.stdout.write(`hbmon-build-mon [${NAME}]: izleniyor (uuid=${UUID}), out=${HBOUT}\n`);

let interruptedFlag = false;
function onInterrupt() {
  if (interruptedFlag) return;
  interruptedFlag = true;
  hbmonRun(["shutdown", "--sock", SOCK], 10000);
  syncBuildLog();
  emit("INTERRUPTED", "monitör kesintiye uğradı, daemon kapatıldı");
  fisek("INTERRUPTED", `monitör kesintiye uğradı (${NAME})`);
  process.exit(143);
}
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);

// --- bekleme döngüsü (erken sinyaller uyarı, terminaller final) ----------------
let warnedStall = false;
let warnedOom = false;
let warnedDep = false;

while (true) {
  const elapsed = elapsedSec();
  let REM;
  if (TIMEOUT > 0) {
    REM = TIMEOUT - elapsed;
    if (REM <= 0) REM = 1;
    if (REM > 600) REM = 600;
  } else {
    REM = 600;
  }
  const w = hbmonRun(["wait", "--sock", SOCK, "--timeout", String(REM), "--until", UNTIL], (REM + 10) * 1000);
  let WOKE = "";
  let STATE = "";
  let CODE = "";
  let RAW = "";
  try {
    const d = JSON.parse(String(w.stdout).trim());
    WOKE = d.woke_on ?? "";
    STATE = d.state ?? "";
    CODE = d.code ?? "";
    RAW = d.exit_event?.raw_code ?? "";
  } catch { /* boş kalır → FAILED terminaline düşer (.sh ile aynı) */ }
  const elapsed2 = elapsedSec();

  if (WOKE === "stall_suspect") {
    if (!warnedStall) {
      warnedStall = true;
      emit("STALLED", `asılı şüphesi (hbmon adaptif eşik, ${elapsed2}sn) (${NAME})`);
      fisek("STALLED", `asılı şüphesi (${NAME})`);
    }
    if (KILL_ON_STALL === 1) {
      hbmonRun(["kill", "--sock", SOCK, "--signal", "TERM"], 15000);
      await sleep(KILL_GRACE * 1000);
      hbmonRun(["kill", "--sock", SOCK, "--signal", "KILL"], 15000);
      syncBuildLog();
      emit("STALLED", "asılı kaldı, --kill-on-stall ile öldürüldü", 111);
      fisek("STALLED", `asılı kaldı, öldürüldü (${NAME})`);
      process.exit(111);
    }
    continue;
  }
  if (WOKE === "oom_suspect" && STATE !== "oom_killed") {
    if (!warnedOom) {
      warnedOom = true;
      emit("OOM_SUSPECT", `OOM şüphesi (hbmon, ${elapsed2}sn) (${NAME})`);
      fisek("OOM_SUSPECT", `OOM şüphesi (${NAME})`);
    }
    continue;
  }
  if (WOKE === "dep_missing") {
    // Ara uyarı (build-mon'da yoktu): terminal sınıflandırma için beklenir.
    if (STATE !== "failed" && STATE !== "dep_missing" && (CODE === "" || CODE === null || CODE === undefined)) {
      if (!warnedDep) {
        warnedDep = true;
        emit("DEP_MISSING", `bağımlılık eksik şüphesi (hbmon pattern) (${NAME})`);
        fisek("DEP_MISSING", `bağımlılık eksik şüphesi (${NAME})`);
      }
      continue;
    }
    // (terminal ise aşağıya düşer)
  }

  // --- terminal sınıflandırma (build-mon.sh ile aynı harita) -------------------
  if (WOKE === "timeout" || STATE === "timeout") {
    syncBuildLog();
    emit("TIMED_OUT", `tavan aşıldı (${TIMEOUT}sn)`, 124);
    fisek("TIMED_OUT", `tavan aşıldı (${NAME}, ${TIMEOUT}sn)`);
    process.exit(124);
  }
  if (STATE === "done" || String(CODE) === "0") {
    syncBuildLog();
    emit("PASSED", `derleme geçti (${elapsed2}sn)`, 0);
    fisek("PASSED", `derleme geçti (${elapsed2}sn) (${NAME})`);
    process.exit(0);
  }
  const rawNum = RAW === "" || RAW === null || RAW === undefined ? NaN : Number(RAW);
  if (Number.isFinite(rawNum) && rawNum > 128) {
    const sig = rawNum - 128;
    const signame = SIGNAME[sig] ?? String(sig);
    syncBuildLog();
    emit("ERROR", `proses sinyal ile öldü: SIG${signame} (exit=${RAW}, ${elapsed2}sn)`, RAW);
    fisek("ERROR", `sinyal ile öldü: SIG${signame} (${NAME})`);
    process.exit(rawNum);
  }
  if (WOKE === "oom_suspect" || STATE === "oom_killed") {
    syncBuildLog();
    emit("ERROR", `OOM killer şüphesi (hbmon, ${elapsed2}sn)`, 137);
    fisek("ERROR", `OOM şüphesi (${NAME})`);
    process.exit(137);
  }
  const ex = excerptOf(HBOUT);
  const codeStr = CODE === "" || CODE === null || CODE === undefined ? "?" : CODE;
  const codeNum = Number(CODE);
  const detail = `derleme hatayla bitti (exit=${codeStr}, ${elapsed2}sn) :: ${ex}`;
  syncBuildLog();
  emit("FAILED", detail, Number.isFinite(codeNum) && CODE !== "" ? codeNum : 1);
  fisek("FAILED", `${detail} (${NAME})`);
  process.exit(Number.isFinite(codeNum) && CODE !== "" ? codeNum : 1);
}
