/**
 * Final-JSON tests (M2, TASK-117): agent her terminal yolda tek satirlik
 * makine-okunur ozet basar; retry karari bu kanita dayanarak CAGIRANDA verilir.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PLATFORM_VERIFIED } from "../scripts/cpu-liveness-probe/cpu-liveness-probe.js";

const agentPath = fileURLToPath(
  new URL("../scripts/cpu-liveness-probe/cpu-liveness-agent.js", import.meta.url),
);

function runAgent(extraFlags, childCmd) {
  const agent = spawn(process.execPath, [agentPath, ...extraFlags, "--", childCmd], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  agent.stdout.on("data", (d) => (out += d));
  const done = new Promise((resolve) => agent.on("exit", (code) => resolve({ code, get out() { return out; } })));
  return { agent, done, get out() { return out; } };
}

function finalJson(out) {
  const lines = out.split("\n").filter((l) => l.includes("[final-json]"));
  assert.equal(lines.length, 1, `tek final-json satiri olmali (bulunan: ${lines.length})`);
  return JSON.parse(lines[0].slice(lines[0].indexOf("{")));
}

test("final-json: completed kosusu semasi", { timeout: 30000 }, async () => {
  if (!PLATFORM_VERIFIED) return;
  const r = runAgent([], `node -e "process.exit(0)"`);
  const { code } = await r.done;
  assert.equal(code, 0);
  const j = finalJson(r.out);
  assert.equal(j.reason, "completed");
  assert.equal(j.exit, 0);
  assert.ok(typeof j.samples.total === "number" && typeof j.graceUsed === "number");
  try { r.agent.kill("SIGKILL"); } catch {}
});

test("final-json: stall-observed (oldurmesiz) semasi", { timeout: 30000 }, async () => {
  if (!PLATFORM_VERIFIED) return;
  // allow-kill YOK + grace KAPALI (--ioGraceRounds=0): stall ateslenir (UYARI),
  // cocuk kendisi 3sn'de bitirir → exit 1, reason stall-observed.
  const r = runAgent(
    ["--intervalMs=500", "--stallThreshold=2", "--ioGraceRounds=0"],
    `node -e "setTimeout(()=>{},3000)"`,
  );
  const { code } = await r.done;
  assert.equal(code, 1);
  const j = finalJson(r.out);
  assert.equal(j.reason, "stall-observed");
  assert.equal(j.exit, 1);
  assert.ok(j.stallSamples >= 2, `stall sayisi tasinmali (bulunan: ${j.stallSamples})`);
  try { r.agent.kill("SIGKILL"); } catch {}
});
