/**
 * Signal test for scripts/cpu-liveness-probe/cpu-liveness-agent.js.
 *
 * Dış timeout agent'ı SIGTERM ile öldürürse derleme torunları YETİM
 * kalmamalı (TASK-115 ailesi: kilit tutar, CPU yakar). Agent SIGTERM'de
 * alt ağacı tree-kill ile temizleyip 143 ile çıkmalı; SIGINT'te 130.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PLATFORM_VERIFIED } from "../scripts/cpu-liveness-probe/cpu-liveness-probe.js";

const agentPath = fileURLToPath(
  new URL("../scripts/cpu-liveness-probe/cpu-liveness-agent.js", import.meta.url),
);
const MARKER = "CL_SIGNAL_PROBE_120s";

function pgrepCount() {
  try {
    // [C] braket hilesi: pgrep -f kendi komut satiriyla eslesmesin.
    const out = execFileSync("pgrep", ["-f", "[C]L_SIGNAL_PROBE_120s"], { encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0; // pgrep exit 1 = eşleşme yok
  }
}

function pgrepCountM5() {
  try {
    const out = execFileSync("pgrep", ["-f", "[C]L_M5_"], { encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function waitForOutput(child, re, ms) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("liveness çıktısı gelmedi")), ms);
    child.stdout.on("data", (d) => {
      buf += d;
      if (re.test(buf)) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on("error", reject);
  });
}

test("SIGTERM: agent 143 ile çıkar, alt ağaç yetim kalmaz", { timeout: 30000 }, async () => {
  if (!PLATFORM_VERIFIED) return; // Linux /proc ailesi
  const agent = spawn(process.execPath, [agentPath, "--", `node -e "/*${MARKER}*/setTimeout(()=>{},120000)"`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForOutput(agent, /\[liveness\]/, 15000);
    assert.ok(pgrepCount() >= 1, "çocuk process çalışıyor olmalı");
    agent.kill("SIGTERM");
    const code = await new Promise((resolve) => agent.on("exit", resolve));
    assert.equal(code, 143);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(pgrepCount(), 0, "yetim process kalmamalı");
  } finally {
    try {
      agent.kill("SIGKILL");
    } catch {}
  }
});

test("SIGTERM: 3 katmanli zincir (agent→bash→sleep,sleep) grup-kill ile iner", { timeout: 30000 }, async () => {
  if (!PLATFORM_VERIFIED) return;
  // detached:true (M5) → bash child grup lideri → kill(-pid) tum agaci indirir.
  const agent = spawn(
    process.execPath,
    [agentPath, "--", "exec -a CL_M5_A sleep 120 & exec -a CL_M5_B sleep 120 & wait"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await waitForOutput(agent, /\[liveness\]/, 15000);
    assert.ok(pgrepCountM5() >= 2, "iki sleep torunu calisiyor olmali");
    agent.kill("SIGTERM");
    const code = await new Promise((resolve) => agent.on("exit", resolve));
    assert.equal(code, 143);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(pgrepCountM5(), 0, "grupta sag kalan olmamali");
  } finally {
    try {
      agent.kill("SIGKILL");
    } catch {}
  }
});
