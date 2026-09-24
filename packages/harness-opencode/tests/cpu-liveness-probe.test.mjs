/**
 * Unit tests for scripts/cpu-liveness-probe/cpu-liveness-probe.js
 * (watchLiveness + readCpuTime + readers) + tree-kill.js.
 *
 * CPU zamanı okuyucuları platform bağımlı ve gerçek process gerektirdiği
 * için burada: (1) readers'ı mock ederek watchLiveness'in mantığını (stall
 * sayımı, onStall tek sefer, stop, ölü process) izole test ediyoruz; (2)
 * gerçek CPU-bound `busy` process ile artan trendi canlı doğruluyoruz.
 *
 * tree-kill: descendants fallback mantığı gerçek `bash -c "sleep N & wait"`
 * ağacıyla doğrulanır (kök + torun ölümlü assert edilir, kalıntı bırakılmaz).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watchLiveness, readCpuTime, PLATFORM_VERIFIED } from "../scripts/cpu-liveness-probe/cpu-liveness-probe.js";
import { treeKill } from "../scripts/cpu-liveness-probe/tree-kill.js";

// --- yardımcılar -------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- watchLiveness: gerçek CPU-bound process ile (Linux'ta) ---------------

test("watchLiveness: busy process (CPU token döndürüyor) → up trend, stall yok", { timeout: 15000 }, async () => {
  if (!PLATFORM_VERIFIED) return; // sadece Linux'ta anlamlı
  // CPU tüketen çocuk: spin loop.
  const child = spawn(process.execPath, ["-e", "const e=Date.now()+4000;while(Date.now()<e){}"], { stdio: "ignore" });

  let upCount = 0;
  let stallFired = false;
  const watch = watchLiveness(child.pid, {
    intervalMs: 300,
    stallThreshold: 3,
    onProgress: (info) => {
      if (info.up === true) upCount += 1;
    },
    onStall: () => {
      stallFired = true;
    },
  });

  await sleep(2500);
  watch.stop();
  try {
    child.kill();
  } catch {}
  await Promise.race([new Promise((r) => child.on("exit", r)), sleep(2000)]);
  assert.ok(upCount >= 2, `busy process en az 2 up örneği vermeli (upCount=${upCount})`);
  assert.equal(stallFired, false, "busy process'te onStall tetiklenmemeli");
});

test("readCpuTime: saf user-space spin (utime) artar — stime-only regresyonu", { timeout: 15000 }, async () => {
  if (!PLATFORM_VERIFIED) return;
  // TASK-117 M5-bugfix: okuyucu fields[12]+fields[13] (stime+cutime) okuyordu;
  // `while(true){}` 8sn'de 3 jiffies gorunuyor, false-stall uretiyordu.
  // Saf spin neredeyse tamamen utime biriktirir — stime-only okuma flat kalirdi.
  const child = spawn(process.execPath, ["-e", "while(true){}"], { stdio: "ignore" });
  try {
    await sleep(500);
    const a = readCpuTime(child.pid);
    await sleep(700);
    const b = readCpuTime(child.pid);
    assert.ok(b > a, `utime artmali (a=${a}, b=${b})`);
    assert.ok(b - a >= 10, `700ms spinde anlamli artis olmali (delta=${b - a})`);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
});

test("watchLiveness: idle-ish process yeterli süre beklerse stall tetikler", { timeout: 20000 }, async () => {
  if (!PLATFORM_VERIFIED) return;
  // 2 saniyelik aralık + eşik 2 → ~4s CPU'suz bekleme → stall.
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 12000)"], { stdio: "ignore" });

  let stallInfo = null;
  const watch = watchLiveness(child.pid, {
    intervalMs: 500,
    stallThreshold: 3,
    onStall: (info) => {
      stallInfo = info;
    },
  });

  await sleep(3500);
  watch.stop();
  try {
    child.kill();
  } catch {}
  await Promise.race([new Promise((r) => child.on("exit", r)), sleep(2000)]);
  assert.ok(stallInfo, "CPU'suz bekleyen process stall tetiklemeli");
});

test("watchLiveness: ölü process → up=null progress (graceful), stall yok", { timeout: 8000 }, async () => {
  if (!PLATFORM_VERIFIED) return;
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((r) => dead.on("exit", r));

  let lastUp = "unset";
  let stallFired = false;
  const watch = watchLiveness(dead.pid, {
    intervalMs: 100,
    stallThreshold: 2,
    onProgress: (info) => {
      lastUp = info.up;
    },
    onStall: () => {
      stallFired = true;
    },
  });
  await sleep(500);
  watch.stop();
  assert.equal(lastUp, null, "ölü process up=null progress vermeli");
  assert.equal(stallFired, false, "ölü process stall sayılmamalı");
});

// --- readTreeCpuTime: işi torun yapıyorsa -----------------------------------
// Gerçek derleme topolojisi: kök (bash) boş bekler, torun CPU yakar.
// Tek PID modu burada flat görür (false stall); tree modu up görür.

test("readTreeCpuTime: torun CPU yakarken toplam artar (kök tek başına flat)", { timeout: 15000 }, async () => {
  if (!PLATFORM_VERIFIED) return;
  const { readTreeCpuTime } = await import("../scripts/cpu-liveness-probe/cpu-liveness-probe.js");
  const child = spawn("bash", ["-c", `${process.execPath} -e "const e=Date.now()+4000;let x=0;while(Date.now()<e){x++}" & wait`], { stdio: "ignore" });
  try {
    await sleep(600); // torunun başlaması için
    const single1 = readCpuTime(child.pid);
    const tree1 = readTreeCpuTime(child.pid);
    await sleep(1200);
    const single2 = readCpuTime(child.pid);
    const tree2 = readTreeCpuTime(child.pid);
    assert.ok(tree2 > tree1, `ağaç toplamı artmalı (tree1=${tree1}, tree2=${tree2})`);
    assert.ok(single2 - single1 < tree2 - tree1, "tek PID artışı ağaç toplamından küçük kalmalı (iş torunda)");
  } finally {
    const { treeKill } = await import("../scripts/cpu-liveness-probe/tree-kill.js");
    await new Promise((r) => treeKill(child.pid, "SIGKILL", r));
  }
});

test("watchLiveness includeTree: torun çalışırken stall YOK; tek PID modda stall VAR", { timeout: 20000 }, async () => {
  if (!PLATFORM_VERIFIED) return;
  const mk = () =>
    spawn("bash", ["-c", `${process.execPath} -e "const e=Date.now()+5000;let x=0;while(Date.now()<e){x++}" & wait`], { stdio: "ignore" });
  const { treeKill } = await import("../scripts/cpu-liveness-probe/tree-kill.js");

  // Tree modu: up trend beklenir.
  const c1 = mk();
  let treeUp = 0;
  let treeStall = false;
  const w1 = watchLiveness(c1.pid, {
    intervalMs: 400,
    stallThreshold: 3,
    includeTree: true,
    onProgress: (i) => {
      if (i.up === true) treeUp += 1;
    },
    onStall: () => {
      treeStall = true;
    },
  });
  await sleep(3000);
  w1.stop();
  await new Promise((r) => treeKill(c1.pid, "SIGKILL", r));

  // Tek PID modu (EXPLICIT opt-out — default artık tree): aynı topolojide
  // stall beklenir (kök bash boş bekler).
  const c2 = mk();
  let singleStall = false;
  const w2 = watchLiveness(c2.pid, {
    intervalMs: 400,
    stallThreshold: 3,
    includeTree: false,
    onProgress: () => {},
    onStall: () => {
      singleStall = true;
    },
  });
  await sleep(3000);
  w2.stop();
  await new Promise((r) => treeKill(c2.pid, "SIGKILL", r));

  assert.ok(treeUp >= 2, `tree modda up örnekleri olmalı (treeUp=${treeUp})`);
  assert.equal(treeStall, false, "tree modda stall olmamalı");
  assert.equal(singleStall, true, "tek PID modda aynı topoloji stall vermeli (neden tree-mod var)");
});

// --- readCpuTime: gerçek okuma (Linux) --------------------------------------

test("readCpuTime: kendi process'imizden okur (≥0)", () => {
  if (!PLATFORM_VERIFIED) return;
  const t = readCpuTime(process.pid);
  assert.ok(Number.isFinite(t) && t >= 0, `cpuTime=${t}`);
});

// --- tree-kill: descendants mantığı -----------------------------------------

test("treeKill: var olmayan pid → callback hatasız döner (ESRCH yutulur), fırlatmaz", (t, done) => {
  treeKill(99999999, "SIGTERM", (err) => {
    // Yok hükmündeki PID'e sinyal = no-op başarı: ESRCH yutulur, err null olur.
    assert.equal(err, null);
    done();
  });
});

test("treeKill: gerçek çocuk process ağacına SIGTERM ulaşır (kök + torun)", { timeout: 15000 }, async () => {
  if (!PLATFORM_VERIFIED) return;
  const { execSync } = await import("node:child_process");
  const child = spawn("bash", ["-c", "sleep 300 & wait"], { stdio: "ignore" });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await sleep(400);
    // Torun sleep pid'ini tree-kill ÖNCESİ yakala (sonradan orphan avı için).
    let grandchild = null;
    try {
      const out = execSync(`ps --ppid ${child.pid} -o pid=`, { encoding: "utf8" }).trim();
      const n = Number(out.split(/\s+/)[0]);
      if (Number.isFinite(n) && n > 0) grandchild = n;
    } catch {}
    assert.ok(grandchild, "torun sleep pid'i test öncesi bulunmalı");
    await new Promise((resolve, reject) =>
      treeKill(child.pid, "SIGTERM", (err) => (err ? reject(err) : resolve())),
    );
    // Sinyal teslimi + reap için kısa bekleme (poll).
    const deadline = Date.now() + 3000;
    while ((alive(child.pid) || (grandchild && alive(grandchild))) && Date.now() < deadline) {
      await sleep(100);
    }
    assert.ok(!alive(child.pid), "kök process ölmüş olmalı");
    assert.ok(!alive(grandchild), "torun sleep ölmüş olmalı (orphan leak yok)");
  } finally {
    // Self-clean: ne olursa olsun kalıntı bırakma.
    try {
      process.kill(child.pid, 9);
    } catch {}
    try {
      execSync(`pkill -9 -P ${child.pid} 2>/dev/null || true`, { stdio: "ignore" });
    } catch {}
  }
});
