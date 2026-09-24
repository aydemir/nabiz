/**
 * I/O-wait tests (M1, TASK-117): classifier unit + grace live proof.
 *
 * Kural: stall + TAZE I/O sinyali + kalan hak → tolerans (oldurme, exit 0
 * mumkun). Ayni sleeper SINYALSIZ ise --allow-kill ile exit 2 (kontrol kolu).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PLATFORM_VERIFIED } from "../scripts/cpu-liveness-probe/cpu-liveness-probe.js";
import { hasFreshLegitWait } from "../scripts/cpu-liveness-probe/io-wait.js";

const agentPath = fileURLToPath(
  new URL("../scripts/cpu-liveness-probe/cpu-liveness-agent.js", import.meta.url),
);
const NOW = 1_000_000;

// --- unit: siniflandirici ----------------------------------------------------

test("classifier: bekleme kelimeleri eslesir, CPU/sonuc kelimeleri eslesmez", () => {
  const yes = [
    "Downloading crates ...",
    "Downloaded foo-1.2.3",
    "Fetching registry index",
    "Blocking waiting for file lock",
    "Waiting for cargo lock",
    "retrying request 2/5",
  ];
  for (const line of yes) {
    assert.ok(hasFreshLegitWait([{ t: NOW, line }], NOW, 15000), line);
  }
  const no = ["Compiling foo v1.2.3", "Finished in 3.2s", "error: build failed", "running 4 tests"];
  for (const line of no) {
    assert.equal(hasFreshLegitWait([{ t: NOW, line }], NOW, 15000), null, line);
  }
});

test("classifier: bayat satir sayilmaz (tazelik penceresi)", () => {
  const entries = [{ t: NOW - 60_000, line: "Downloading old stuff" }];
  assert.equal(hasFreshLegitWait(entries, NOW, 15000), null);
  entries.push({ t: NOW - 1000, line: "Compiling x" });
  assert.equal(hasFreshLegitWait(entries, NOW, 15000), null, "taze ama eslesmeyen satir yetmez");
});

// --- live: tolerans vs kontrol ------------------------------------------------

function runAgent(extraFlags, childCmd) {
  const agent = spawn(process.execPath, [agentPath, ...extraFlags, "--", childCmd], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  agent.stdout.on("data", (d) => (out += d));
  const done = new Promise((resolve) => agent.on("exit", resolve));
  return { agent, done, get out() { return out; } };
}

test("live: taze I/O sinyali + --allow-kill → tolerans, cocuk bitirir, exit 0", { timeout: 60000 }, async () => {
  if (!PLATFORM_VERIFIED) return;
  const child = `node -e "console.log('Downloading crates...'); setTimeout(()=>{console.log('done');},12000)"`;
  const r = runAgent(
    ["--intervalMs=1000", "--stallThreshold=3", "--allow-kill", "--ioGraceRounds=8"],
    child,
  );
  const code = await r.done;
  assert.equal(code, 0, `toleransla bitmeli (cikti: ${r.out.slice(-400)})`);
  assert.ok(r.out.includes("Tolerans"), "tolerans logu gorulmeli");
  assert.ok(!r.out.includes("tree-kill(SIGTERM"), "oldurme olmamali");
  try { r.agent.kill("SIGKILL"); } catch {}
});

test("live: ayni sleeper SINYALSIZ + --allow-kill → exit 2 (kontrol kolu)", { timeout: 60000 }, async () => {
  if (!PLATFORM_VERIFIED) return;
  const child = `node -e "setTimeout(()=>{},30000)"`;
  const r = runAgent(
    ["--intervalMs=1000", "--stallThreshold=3", "--allow-kill", "--ioGraceRounds=8"],
    child,
  );
  const code = await r.done;
  assert.equal(code, 2, `sinyalsiz stall oldurulmeli (cikti: ${r.out.slice(-400)})`);
  try { r.agent.kill("SIGKILL"); } catch {}
});
