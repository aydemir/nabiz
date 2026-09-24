#!/usr/bin/env node
// scripts/cpu-liveness-probe/cpu-liveness-agent.js
// Build/derleme işlemini başlat + CPU-liveness ile izle + asılıysa tree-kill.
//
// Bu script bir ABSRACT ajans değil, tek dosyalık SOMUT bir runner: verilen
// bir komutu spawn eder, çıktısını stream eder, ve aynı anda
// cpu-liveness-probe ile PID'in CPU zamanını izler. `onStall` tetiklenince
// otomatik öldürmez — değerlendirmeyi `--allow-kill` + stall süresi üzerinden
// yapar ve I/O-bekleme riskine karşı bir ön-uyarı loglar.
//
// Kullanım (flag'ler -- ÖNCESİNE yazılır, parse kodu sep öncesini okur):
//   node cpu-liveness-agent.js -- <build cmd>...
//   node cpu-liveness-agent.js --allow-kill -- <build cmd>...
//   node cpu-liveness-agent.js --intervalMs=1000 --stallThreshold=10 -- <build cmd>...
//   node cpu-liveness-agent.js --maxBudgetMs=600000 --ioGraceRounds=3 -- <build cmd>...
//   Not: <build cmd>... tek bir shell komutu olarak birleştirilip /bin/bash -c
//   ile koşulur (TASK-115 orphan regresyonu korunur). Boşluklu argümanlar
//   tırnak içinde verilmeli: `-- node -e "let x=0;while(1){x}"`
//
// Davranış:
//   - Komut spawn edilir (shell: /bin/bash — TASK-115 orphan regresyonu korunur).
//   - Her `intervalMs`'te çocuğun CPU zamanı + canlı torunların toplamı
//     (includeTree — işi yapan npm→tsc gibi torunlardır, tek PID flat görünür)
//     ölçülür; trend loglanır.
//   - `stallThreshold` ardışık delta=0 → onStall.
//   - onStall: once TAZE I/O sinyali kontrolu (M1: son ciktida download/
//     fetch/lock/wait; cap'li tolerans, sayac sifirlanir, oldurulmez).
//     Sonra: `--allow-kill` VERİLMİŞSE ve tolerans tukenmisse tree-kill.
//     Aksi halde yalnızca uyarı loglar, öldürmez (I/O-bekleme false positive riski).
//   - `--maxBudgetMs` (M4, default kapali): ic tavan; asimda toleransa
//     bakilmadan tree-kill, exit 4. Dis harness tavanindan bagimsiz.
//   - Exit code: 0=temiz, 1=stall algılandı ama öldürülmedi (tüketici karar verir),
//     2=allow-kill + gerçek stall → tree-kill uygulandı, 3=komut kendisi hatalı,
//     4=bütçe aşıldı (stall hükmüyle karışmaz).

import { spawn } from "node:child_process";
import { watchLiveness } from "./cpu-liveness-probe.js";
import { treeKill } from "./tree-kill.js";
import {
  hasFreshLegitWait,
  IO_FRESH_MS_DEFAULT,
  IO_GRACE_ROUNDS_DEFAULT,
} from "./io-wait.js";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
const cmdArgs = sep >= 0 ? args.slice(sep + 1) : args;
const flags = {};

for (let i = 0; i < sep; i++) {
  const a = args[i];
  if (a === "--allow-kill") flags.allowKill = true;
  else if (a.startsWith("--intervalMs=")) flags.intervalMs = Number(a.split("=")[1]) || 2000;
  else if (a.startsWith("--stallThreshold=")) flags.stallThreshold = Number(a.split("=")[1]) || 3;
  else if (a.startsWith("--maxBudgetMs=")) flags.maxBudgetMs = Number(a.split("=")[1]) || 0;
  else if (a.startsWith("--ioFreshMs=")) flags.ioFreshMs = Number(a.split("=")[1]) || IO_FRESH_MS_DEFAULT;
  else if (a.startsWith("--ioGraceRounds=")) flags.ioGraceRounds = Number(a.split("=")[1]);
  else if (a === "--") continue;
}

if (cmdArgs.length === 0) {
  console.error("Usage: node cpu-liveness-agent.js [flags BEFORE --] -- <build cmd...> (flags: --allow-kill --intervalMs=N --stallThreshold=N --maxBudgetMs=N --ioFreshMs=N --ioGraceRounds=N)");
  process.exit(3);
}

const intervalMs = flags.intervalMs ?? 2000;
const stallThreshold = flags.stallThreshold ?? 3;
const maxBudgetMs = flags.maxBudgetMs ?? 0; // 0 = kapali (default). Tavan butcedir, dedektor degil.
const ioFreshMs = flags.ioFreshMs ?? IO_FRESH_MS_DEFAULT;
const ioGraceRounds = Number.isFinite(flags.ioGraceRounds)
  ? flags.ioGraceRounds
  : IO_GRACE_ROUNDS_DEFAULT; // 0 = tolerans kapali

const child = spawn(cmdArgs.join(" "), {
  shell: "/bin/bash",
  stdio: ["ignore", "pipe", "pipe"],
  // M5 (TASK-117): kendi process-group'unda baslat (grup lideri = bash child).
  // tree-kill.js once `kill(-pid)` dener — grup lideri varsa bu TEK sinyal
  // tum agaci indirir (yariş penceresi kapanir); degilse descendants
  // fallback'i calisir. Terminal Ctrl-C artik gruba gitmez; dis harness
  // sinyali dogrudan agent pid'ine atar (zaten SIGTERM/SIGINT handler var).
  detached: true,
});

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

// M1 (TASK-117): cikti muslugu — son 200 parcayi zaman damgali tutar.
// Tazelik penceresi (ioFreshMs) disindakiler sayilmaz; bayat "downloading"
// satiri tolerans uretemez.
const recentOut = [];
function tapOutput(chunk) {
  recentOut.push({ t: Date.now(), line: chunk.toString() });
  if (recentOut.length > 200) recentOut.splice(0, recentOut.length - 200);
}
child.stdout.on("data", tapOutput);
child.stderr.on("data", tapOutput);

let stats = { samples: 0, up: 0, down: 0, lastDelta: 0 };
let stallInfo = null;
let budgetExceeded = false;

let graceUsed = 0;
let watch = null;

function startWatch() {
  watch = watchLiveness(child.pid, {
  intervalMs,
  stallThreshold,
  includeTree: true, // probe default'u zaten true; burada AÇIK yazıldı ki karar
  // çağrı noktasında da keşfedilebilir olsun (sessiz default'a güvenme).
  onProgress: (info) => {
    if (info.up === null) return; // process bitti, aşağıda ele alınır
    stats.samples += 1;
    if (info.up) stats.up += 1;
    else stats.down += 1;
    stats.lastDelta = info.delta;
    process.stdout.write(
      `[liveness] sample=${stats.samples} cpuTime=${info.cpuTime?.toFixed ? info.cpuTime.toFixed(2) : info.cpuTime} delta=${info.delta?.toFixed ? info.delta.toFixed(2) : info.delta} up=${info.up}\n`,
    );
  },
  onStall: (info) => {
    stallInfo = info;
    // M1 grace: SADECE stall ateslenmisse (delta==0) bakilir — CPU yakan
    // process buraya hic gelmez (M1xM3 celiskisi kodda cozulur). Taze I/O
    // sinyali + kalan hak varsa sayac sifirlanir (watch yeniden) ve
    // OLDURULMEZ (--allow-kill olsa bile). Butce (M4) bu dala hic
    // danisilmaz — ayri timer, toleranstan bagimsiz her zaman kazanir.
    const freshWait =
      ioGraceRounds > 0 ? hasFreshLegitWait(recentOut, Date.now(), ioFreshMs) : null;
    if (freshWait && graceUsed < ioGraceRounds) {
      graceUsed += 1;
      process.stdout.write(
        `\n[stall] CPU ${info.stallSamples} ardışık ölçümde artmadı ama TAZE I/O sinyali: "${freshWait.trim().slice(0, 80)}". ` +
          `Tolerans ${graceUsed}/${ioGraceRounds} — sayaç sıfırlandı, izlemeye devam.\n`,
      );
      watch.stop();
      stallInfo = null; // tolerans: henuz hukum yok
      startWatch();
      return;
    }
    const stallDurationMs = info.stallSamples * intervalMs;
    // Karar gerekçesi: I/O bekleme riski vs gerçek asılma.
    // Bu tool CPU-bound DERLEME araçları içindir; genel bash exec katmanına UYGULANMAZ.
    if (flags.allowKill) {
      process.stdout.write(
        `\n[stall] Asılı olabilir: CPU ${info.stallSamples} ardışık ölçümde artmadı (${stallDurationMs}ms). ` +
          `--allow-kill VERİLDİ → tree-kill(SIGTERM, pid=${child.pid}) uygulanıyor. ` +
          `Not: bu I/O beklemesi ise false positive olabilir.\n`,
      );
      treeKill(child.pid, "SIGTERM", (err) => {
        if (err) process.exitCode = 2;
      });
    } else {
      process.stdout.write(
        `\n[stall] UYARI: CPU ${info.stallSamples} ardışık ölçümde artmadı (${stallDurationMs}ms). ` +
          `Öldürmedim — I/O beklemesi olabilir (false positive). --allow-kill eklersen SIGTERM atar.\n`,
      );
    }
  },
  });
}

startWatch();

child.on("exit", (code, signal) => {
  watch.stop();
  if (budgetTimer) clearTimeout(budgetTimer);
  if (shuttingDown) return; // sinyal-le kapanis kendi exit kodunu verir
  process.stdout.write(
    `\n[agent] Çıktı: exit=${code} signal=${signal} || ölçüm=${stats.samples} (up=${stats.up}, down=${stats.down}) sonDelta=${stats.lastDelta}\n`,
  );
  // M2 (TASK-117): makine-okunur final ozeti — retry karari KANITLA cagiranda
  // verilir; agent otomatik tazelemez. `reason` asla duvar-saati hukmu degil.
  let reason;
  if (budgetExceeded) {
    process.exitCode = 4; // butce asti — stall hukmuyle karismaz
    reason = "budget-exceeded";
  } else if (stallInfo && flags.allowKill) {
    process.exitCode = 2; // tree-kill uygulandı (veya denendi)
    reason = "stall-killed";
  } else if (stallInfo) {
    process.exitCode = 1; // stall algılandı, öldürülmedi
    reason = "stall-observed";
  } else {
    process.exitCode = code ?? 0;
    reason = "completed";
  }
  process.stdout.write(
    `\n[final-json] ${JSON.stringify({
      reason,
      exit: process.exitCode,
      signal: signal ?? null,
      stallSamples: stallInfo ? stallInfo.stallSamples : 0,
      samples: { total: stats.samples, up: stats.up, down: stats.down },
      graceUsed,
    })}\n`,
  );
});

// M4 (TASK-117): ic opt-in tavan. Doktrin serhi: dis harness tavani
// production'da birincil ve zorunlu; bu ic tavan test/standalone'da onun
// yerini tutan KANIT mekanizmasi (M3 busy-loop yakalama). Default KAPALI.
// Grace (M1) dahil HICBIR toleransa danisilmaz — butce her zaman kazanir.
let budgetTimer = null;
if (maxBudgetMs > 0) {
  budgetTimer = setTimeout(() => {
    budgetExceeded = true;
    watch.stop();
    process.stdout.write(
      `\n[budget] Butce asti (${maxBudgetMs}ms). Hukum degil, tavan: tree-kill(SIGTERM, pid=${child.pid}).\n`,
    );
    treeKill(child.pid, "SIGTERM", () => {
      process.exitCode = 4;
    });
    setTimeout(() => process.exit(4), 5000).unref();
  }, maxBudgetMs);
}

// Dış timeout (tool `timeout_ms`) agent'ı öldürürse derleme torunları
// YETİM kalırdı (kilit tutar, CPU yakar — TASK-115 ailesi). Bu yüzden
// SIGTERM/SIGINT'te alt ağaç temizlenip CİDDİ exit koduyla çıkılır
// (143=SIGTERM, 130=SIGINT). --allow-kill'den BAĞIMSIZ: dış katman
// "bitti" dediyse temizlik zorunlu. (SIGKILL yakalanamaz; dış katman
// önce SIGTERM atmalı.)
let shuttingDown = false;
for (const [sig, sigExit] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    watch.stop();
    process.stdout.write(`\n[agent] ${sig} alındı → alt ağaç temizleniyor (pid=${child.pid}).\n`);
    process.stdout.write(
      `\n[final-json] ${JSON.stringify({
        reason: "terminated-" + sig.toLowerCase(),
        exit: sigExit,
        signal: sig,
        stallSamples: stallInfo ? stallInfo.stallSamples : 0,
        samples: { total: stats.samples, up: stats.up, down: stats.down },
        graceUsed,
      })}\n`,
    );
    treeKill(child.pid, "SIGTERM", () => process.exit(sigExit));
    setTimeout(() => process.exit(sigExit), 5000).unref();
  });
}
