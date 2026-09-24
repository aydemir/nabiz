#!/usr/bin/env node
// scripts/cpu-liveness-probe/tree-kill.js
// Bağımlılıksız process ağacı öldürücü (npm `tree-kill` davranışını taklit eder,
// ama harici paket gerektirmez — bu repo no-dependency politikasına uyar,
// TASK-113).
//
// Ağaç öldürme stratejisi (Linux):
//   1. `process.kill(-pid, signal)` — NEGATİF pid, process-group'a sinyal
//      gönderir. YALNIZCA pid bir group lideriyse işe yarar. Node ile spawn
//      edilen bir çocuğun pgid'i genellikle NODE'UN pgid'idir (yeni group
//      açılmaz) → kill(-pid) ESRCH fırlatır. Yani group-kill "güzel olurdu"
//      bir kolaylıktır, asıl garanti DESCENDANTS fallback'idir.
//   2. Fallback (ASIL YOL): `ps --ppid <pid>` ile descendants recursive + her
//      toruna/yaprağa tek tek sinyal. ESRCH'leri yut (zaten ölmüş).
//   3. Kök process'in kendisini de vur.
//
// Not: /proc/<pid>/task/<tid>/children dosyası bazı ortamlarda (container)
// yok; bu yüzden çocuk listeleme `ps --ppid` ile (TASK-115 probe ile aynı
// aile).
//
// macOS/Windows: darwin'de process-group negatif-pid Linux'a özgüdür, alt
// process'ler `ps -o ppid=` ile recursive toplanır; win32'de
// `taskkill /pid <pid> /T /F` çağrılır. Bu platformlar TEST EDİLMEDİ.

import { execFileSync } from "node:child_process";

function childrenOf(pid) {
  // Linux: `ps --ppid <pid>` (GNU ps, TASK-115 probe ile aynı aile).
  // darwin/other: BSD ps'te --ppid yok; `ps -o pid=,ppid=` çıktısı parse edilir.
  // Not: /proc/<pid>/task/<tid>/children dosyası bazı ortamlarda (container)
  // mevcut değil (ENOENT) — bu yüzden ps tercih edildi.
  try {
    if (process.platform === "linux") {
      const out = execFileSync("ps", ["--ppid", String(pid), "-o", "pid="], { encoding: "utf8" });
      return out.trim() ? out.trim().split(/\s+/).map(Number).filter(Boolean) : [];
    }
    const out = execFileSync("ps", ["-o", "pid=,ppid="], { encoding: "utf8" });
    const kids = [];
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/).map(Number);
      if (parts.length === 2 && parts[1] === Number(pid) && Number.isFinite(parts[0])) kids.push(parts[0]);
    }
    return kids;
  } catch {
    return []; // eşleşme yok / komut hatası
  }
}

// pid'in tüm torunları (pid dahil değil). cpu-liveness-probe.js'teki
// readTreeCpuTime da bunu reuse eder (tek implementasyon, çift kullanım).
export function descendants(pid) {
  const out = [];
  const stack = [pid];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    for (const c of childrenOf(p)) {
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}

function killIgnoringEsrch(pids, signal) {
  for (const p of pids) {
    try {
      process.kill(p, signal);
    } catch (e) {
      if (e.code !== "ESRCH") throw e; // ESRCH: zaten ölmüş → sorun değil
    }
  }
}

export function treeKill(pid, signal = "SIGTERM", cb) {
  if (typeof signal === "function") {
    cb = signal;
    signal = "SIGTERM";
  }
  let err = null;

  const finish = () => {
    if (typeof cb === "function") cb(err);
  };

  try {
    if (process.platform === "win32") {
      // Windows: taskkill /T (ağaç) /F (force). /T process grubunu kapar.
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      return finish();
    }

    if (process.platform === "linux") {
      // 1) Group-kill "güzel olurdu" — ESRCH (pid group lideri değil) ise
      //    devam et, fallback zaten her iki durumda da çalışır.
      try {
        process.kill(-pid, signal);
      } catch (e) {
        if (e.code !== "ESRCH" && e.code !== "EPERM") throw e;
      }
      // 2) ASIL GARANTİ: descendants recursive + tek tek sinyal (yapraktan
      //    köke). ESRCH'ler yutulur.
      const tree = descendants(pid);
      killIgnoringEsrch(tree.reverse(), signal);
      // 3) Kök process'in kendisi.
      killIgnoringEsrch([pid], signal);
      return finish();
    }

    // darwin/other: children recursive + sinyal (darwin negatif-pid group
    // semantiği Linux'tan farklı, fallback garanti).
    const tree = descendants(pid);
    killIgnoringEsrch(tree.reverse(), signal);
    killIgnoringEsrch([pid], signal);
    return finish();
  } catch (e) {
    err = e;
    return finish();
  }
}

export default treeKill;