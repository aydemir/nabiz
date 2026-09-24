/**
 * Budget test for scripts/cpu-liveness-probe/cpu-liveness-agent.js (M4, TASK-117).
 *
 * --maxBudgetMs: ic opt-in tavan (default kapali). Asimda tree-kill + exit 4.
 * Ayni kosum M3'un kanitidir: CPU-yakan busy-loop'ta liveness hep "up" der
 * (dedektor kor), yakalayan tavandir.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PLATFORM_VERIFIED } from "../scripts/cpu-liveness-probe/cpu-liveness-probe.js";

const agentPath = fileURLToPath(
  new URL("../scripts/cpu-liveness-probe/cpu-liveness-agent.js", import.meta.url),
);

test("budget: busy-loop (hep up) maxBudgetMs'te tree-kill + exit 4", { timeout: 30000 }, async () => {
  if (!PLATFORM_VERIFIED) return;
  const t0 = Date.now();
  const agent = spawn(
    process.execPath,
    [
      agentPath,
      "--intervalMs=500",
      "--stallThreshold=3",
      "--maxBudgetMs=5000",
      "--",
      `node -e "while(true){}"`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  agent.stdout.on("data", (d) => (out += d));
  const code = await new Promise((resolve) => agent.on("exit", resolve));
  const elapsed = Date.now() - t0;
  assert.equal(code, 4);
  assert.ok(out.includes("[budget]"), "budget logu gorulmeli");
  assert.ok(/up=true/.test(out), "liveness loop boyunca up demeli (M3 korlugu)");
  assert.ok(!out.includes("[stall]"), "onStall HIC ateslenmemeli (hukum yok, yakalayan tavan)");
  assert.ok(elapsed < 20000, `budget ~5sn'de indirmeli (surdu: ${elapsed}ms)`);
  try {
    agent.kill("SIGKILL");
  } catch {}
});

test("budget default kapali: hizli komut etkilenmez", { timeout: 30000 }, async () => {
  if (!PLATFORM_VERIFIED) return;
  const agent = spawn(process.execPath, [agentPath, "--", `node -e "process.exit(0)"`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const code = await new Promise((resolve) => agent.on("exit", resolve));
  assert.equal(code, 0);
});
