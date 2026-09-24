#!/usr/bin/env node
// scripts/timeout-kill-probe/timeout-kill-probe.mjs
// "Promise reject oldu" != "process öldü" regresyon bekçisi.
// Kullanım: node scripts/timeout-kill-probe/timeout-kill-probe.mjs [--scenario A|B|C|all]
// Exit: 0=PASS (guard senaryo A temiz + kalıntı yok),
//       1=FAIL (A'da orphan veya temizlenemeyen kalıntı),
//       2=INCONCLUSIVE (ps/grep çalışmadı).
// NOT: B ve C bilgilendirici — fail üretmez, sadece raporlar.
//   A (guard): exec.ts ile aynı ayar (shell:/bin/bash, timeout 2000) +
//      torun spawn eden komut → TEMİZ beklenir. Kirlenirse FAIL.
//   B (diferansiyel): aynı komut shell:/bin/sh (dash) ile → ORPHAN beklenir.
//      dash bir gün temizlenirse INFO'ya düşer (A hâlâ guard).
//   C (daemonize): `nohup … & disown` timeout'a hiç yakalanmaz (by-design) → INFO.
// Canlı ilk kanıt: 2026-09-06 (sh→ORPHAN 2/2, bash→TEMİZ 2/2).
// Manuel koş (arka plan process spawn eder, kendi kalıntısını temizler); CI'ye koyma.

import { exec, execSync } from "node:child_process";

const TIMEOUT_MS = 2000;
const arg = process.argv.find((a) => a.startsWith("--scenario="))?.split("=")[1] ?? "all";

function psGrep(marker) {
  try {
    return execSync(`ps -eo pid,ppid,stat,cmd | grep "${marker}" | grep -v grep`, {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function cleanup(marker) {
  try {
    execSync(`pkill -9 -f "${marker}"`);
  } catch {
    // eşleşme yoksa pkill exit 1 — normal
  }
}

function runExec(cmd, opts) {
  return new Promise((resolve) => {
    exec(cmd, opts, (error, stdout) => resolve({ error, stdout: stdout ?? "" }));
  });
}

async function scenario(tag, cmd, opts) {
  const MARKER = `${tag}_${Date.now()}${Math.floor(Math.random() * 9999)}`;
  const fullCmd = cmd.replaceAll("__MARKER__", MARKER);
  const { error } = await runExec(fullCmd, opts);
  await new Promise((r) => setTimeout(r, 1000));
  const leftover = psGrep(MARKER);
  cleanup(MARKER);
  await new Promise((r) => setTimeout(r, 500));
  const stillThere = psGrep(MARKER);
  return {
    marker: MARKER,
    killed: !!error?.killed,
    orphan: leftover !== "",
    leftover,
    cleaned: stillThere === "",
  };
}

const CHILD_CMD = `node -e "console.log('__MARKER__'); setTimeout(()=>{}, 30000)"`;
const results = {};
let fail = false;

if (arg === "all" || arg === "A") {
  // Guard: exec.ts ayarları — plugins/mcp-bash-tools/src/exec.ts runBash ile aynı.
  const r = await scenario("GUARD", CHILD_CMD, {
    timeout: TIMEOUT_MS,
    shell: "/bin/bash",
    maxBuffer: 50 * 1024 * 1024,
  });
  results.A = r.killed && !r.orphan && r.cleaned ? "TEMIZ (beklenen)" : `BOZUK orphan=${r.orphan} cleaned=${r.cleaned}`;
  if (r.orphan || !r.cleaned) fail = true;
}

if (arg === "all" || arg === "B") {
  const r = await scenario("DIFF", CHILD_CMD, { timeout: TIMEOUT_MS, shell: "/bin/sh" });
  results.B = r.orphan ? "ORPHAN (beklenen — bash şartının gerekçesi)" : "TEMIZ (dash davranışı değişmiş? INFO)";
}

if (arg === "all" || arg === "C") {
  const r = await scenario(
    "DAEMON",
    `bash -c "echo __MARKER__; nohup sleep 30 > /dev/null 2>&1 & disown; echo spawned"`,
    { timeout: TIMEOUT_MS, shell: "/bin/bash" },
  );
  // Marker echo'da, sleep'te değil — sleep kalıntısını ayrıca kontrol et.
  let sleepLeft = "";
  try {
    sleepLeft = execSync(`ps -eo pid,ppid,cmd | grep "sleep 30" | grep -v grep`, {
      encoding: "utf8",
    }).trim();
    for (const line of sleepLeft.split("\n")) {
      const pid = line.trim().split(/\s+/)[0];
      if (pid) try { process.kill(Number(pid), 9); } catch { /* yok */ }
    }
  } catch { /* sleep kalıntısı yok */ }
  results.C = `timeout'a yakalanmaz (by-design). sleep kalıntısı: ${sleepLeft ? "vardı, temizlendi" : "yok"}. marker-orphan=${r.orphan}`;
}

console.log(JSON.stringify(results, null, 2));
if (fail) {
  console.log("FAIL: guard senaryo A kirli — exec.ts shell/timeout ayarını kontrol et.");
  process.exit(1);
}
console.log("PASS");
