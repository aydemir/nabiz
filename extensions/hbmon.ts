/**
 * hbmon — uzun build takibi için pi extension (Faz 1).
 *
 * Port kaynağı: /root/opencode-plugins/plugins/opencode-hbmon.ts +
 * plugins/lib/hbmon-tools.ts (TASK-126). Davranış birebir korunur:
 * aynı handshake, aynı özet cümleleri, aynı `until` isimleri.
 *
 * Yükleme: pi -e /root/nabiz/extensions/hbmon.ts
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const HBMON_INSTALL_HINT =
  "hbmon bulunamadı. Kurulum (git — crates.io yayını stabil sürüme kadar " +
  "bilinçli ertelendi): cargo install --git https://github.com/aydemir/hbmon " +
  "(veya HBMON_BIN=/yol/hbmon)";

function resolveHbmonBin(env: NodeJS.ProcessEnv = process.env): string {
  const direct = (env.HBMON_BIN ?? "").trim();
  return direct === "" ? "hbmon" : direct;
}

interface HbmonRun {
  code: number;
  stdout: string;
  stderr: string;
  json?: unknown;
  error?: string;
}

function parseJson(text: string): unknown | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  try {
    return JSON.parse(t);
  } catch {
    for (const line of t.split("\n")) {
      const s = line.trim();
      if (s.startsWith("{")) {
        try {
          return JSON.parse(s);
        } catch {
          continue;
        }
      }
    }
    return undefined;
  }
}

/** hbmon'u çalıştır, çıktıyı topla. Shell yok — argv aynen taşınır. */
function runHbmon(
  bin: string,
  args: string[],
  execTimeoutMs = 70000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HbmonRun> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { encoding: "utf8", timeout: execTimeoutMs, windowsHide: true, env },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errText = String(stderr ?? "");
        if (err && typeof (err as NodeJS.ErrnoException).code === "string") {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            resolve({ code: 127, stdout: out, stderr: errText, error: HBMON_INSTALL_HINT });
            return;
          }
        }
        const killed = !!err && (err as Error & { killed?: boolean }).killed === true;
        const exitCode =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as unknown as { code: number }).code
            : 0;
        resolve({
          code: exitCode,
          stdout: out,
          stderr: errText,
          json: parseJson(out),
          ...(killed ? { error: `hbmon çağrısı zaman aşımı (${execTimeoutMs}ms)` } : {}),
        });
      },
    );
  });
}

interface WatchHandshake {
  uuid: string;
  sock: string;
  log: string;
}

async function watchBuild(
  bin: string,
  command: string[],
  opts: { uuid?: string; timeoutSec?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ handshake?: WatchHandshake; raw: HbmonRun; error?: string }> {
  const args = ["watch", "--detach"];
  if (opts.uuid) args.push("--uuid", opts.uuid);
  if (opts.timeoutSec !== undefined) args.push("--timeout-sec", String(opts.timeoutSec));
  args.push("--", ...command);
  const raw = await runHbmon(bin, args, 30000, opts.env);
  if (raw.error) return { raw, error: raw.error };
  const j = raw.json as Partial<WatchHandshake> | undefined;
  if (raw.code !== 0 || !j || typeof j.uuid !== "string" || typeof j.sock !== "string") {
    return {
      raw,
      error: `hbmon watch başarısız (exit ${raw.code}): ${(raw.stderr || raw.stdout).trim().slice(0, 300)}`,
    };
  }
  return {
    handshake: { uuid: j.uuid, sock: j.sock, log: typeof j.log === "string" ? j.log : "" },
    raw,
  };
}

interface WaitResult {
  response?: unknown;
  summary: string;
  error?: string;
}

async function waitBuild(
  bin: string,
  sock: string,
  opts: { timeoutSec?: number; until?: string; env?: NodeJS.ProcessEnv; startupGraceMs?: number } = {},
): Promise<WaitResult> {
  const daemonTimeout = opts.timeoutSec ?? 50;
  const args = ["wait", "--sock", sock, "--timeout", String(daemonTimeout)];
  if (opts.until) args.push("--until", opts.until);
  const execMs = (daemonTimeout + 15) * 1000;
  const deadline = Date.now() + (opts.startupGraceMs ?? 10000);
  let raw = await runHbmon(bin, args, execMs, opts.env);
  while (!raw.json && isConnectionError(raw) && Date.now() < deadline) {
    await sleep(250);
    raw = await runHbmon(bin, args, execMs, opts.env);
  }
  if (raw.error) return { summary: raw.error, error: raw.error };
  const r = raw.json as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") {
    return { summary: `hbmon wait parse edilemedi (exit ${raw.code})`, error: "bad json" };
  }
  return { response: r, summary: summarizeWait(r, raw.code) };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isConnectionError(raw: HbmonRun): boolean {
  if (raw.code !== 3) return false;
  const text = `${raw.stderr}\n${raw.stdout}`;
  return /pipe (wait|connect)|connect /i.test(text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function summarizeWait(r: Record<string, unknown>, exitCode: number): string {
  const woke = str(r.woke_on);
  const state = str(r.state);
  const code = num(r.code) ?? exitCode;
  const dur = num(r.duration_sec);
  const durText = dur === undefined ? "" : ` in ${dur.toFixed(1)}s`;
  if (r.timeout === true) return `timeout (hâlâ çalışıyor)${durText} — tekrar hbmon_wait çağır`;
  if (woke && (state === "running" || state === "stalled") && r.code === undefined) {
    return `woke_on=${woke} state=${state}${durText} — hbmon_status ile detaya bak`;
  }
  if (state === "done") return `done code=${code}${durText}`;
  if (state === "dep_missing") return `dep_missing (exit 2)${durText} — log'a bak, bitmesini bekleme`;
  if (state === "failed") return `failed code=${code}${durText}`;
  if (state !== "") return `${state} code=${code}${durText}`;
  return `wait exit=${exitCode}${durText}`;
}

async function statusBuild(
  bin: string,
  sock: string,
  env: NodeJS.ProcessEnv = process.env,
  startupGraceMs = 10000,
): Promise<{ response?: unknown; error?: string }> {
  let raw = await runHbmon(bin, ["status", "--sock", sock], 30000, env);
  const deadline = Date.now() + startupGraceMs;
  while (!raw.json && isConnectionError(raw) && Date.now() < deadline) {
    await sleep(250);
    raw = await runHbmon(bin, ["status", "--sock", sock], 30000, env);
  }
  if (raw.error) return { error: raw.error };
  if (!raw.json || typeof raw.json !== "object") {
    return { error: `hbmon status parse edilemedi (exit ${raw.code})` };
  }
  return { response: raw.json };
}

// --- pi extension ---

const WatchParams = Type.Object({
  command: Type.Array(Type.String(), {
    description: "Build komutu argv dizisi, örn. ['cargo','build','--release']",
  }),
  uuid: Type.Optional(Type.String({ description: "İzleyici kimliği (boşsa üretilir)" })),
  timeout_sec: Type.Optional(
    Type.Number({ description: "Derleme tavanı sn (sonra SIGTERM→SIGKILL, exit 124)" }),
  ),
});

const WaitParams = Type.Object({
  sock: Type.String({ description: "hbmon_watch'tan dönen sock" }),
  timeout: Type.Optional(Type.Number({ description: "Daemon tavanı sn (default 50)" })),
  until: Type.Optional(
    Type.String({
      description: "Erken-dönüş sinyalleri, virgüllü (done,failed,dep_missing,stall_suspect,oom_suspect,timeout). Yoksa yalnızca bitiş.",
    }),
  ),
});

const StatusParams = Type.Object({
  sock: Type.String({ description: "hbmon_watch'tan dönen sock" }),
});

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

export default function (pi: ExtensionAPI) {
  const bin = resolveHbmonBin();

  pi.registerTool({
    name: "hbmon_watch",
    label: "hbmon watch",
    description:
      "Uzun build turn-içi takip: komutu hbmon ile arka planda başlat, hemen dön (bash'te bloklama). Dönen sock'u sonraki hbmon_wait/hbmon_status çağrılarına ver. Argv dizisi ver, shell yok.",
    parameters: WatchParams,
    async execute(_id, params) {
      const w = await watchBuild(bin, params.command, {
        uuid: params.uuid,
        timeoutSec: params.timeout_sec,
      });
      if (!w.handshake) return textResult(`hbmon_watch BAŞARISIZ: ${w.error}`);
      return textResult(
        [
          `hbmon_watch OK uuid=${w.handshake.uuid}`,
          `sock=${w.handshake.sock}`,
          `log=${w.handshake.log}`,
          "Sonra: hbmon_wait (bekle) veya hbmon_status (yokla).",
        ].join("\n"),
        { uuid: w.handshake.uuid, sock: w.handshake.sock },
      );
    },
  });

  pi.registerTool({
    name: "hbmon_wait",
    label: "hbmon wait",
    description:
      "Sock'lu build bitene kadar bloklanarak bekle (polling YOK — bu çağrı uyandırır). Daemon tavanı default 50s; `timeout (hâlâ çalışıyor)` dönerse aynı sock ile tekrar çağır. Erken-dönüş için until: done,failed,dep_missing,stall_suspect,oom_suspect,timeout (virgüllü).",
    parameters: WaitParams,
    async execute(_id, params) {
      const w = await waitBuild(bin, params.sock, {
        timeoutSec: params.timeout,
        until: params.until,
      });
      const body = w.response !== undefined ? JSON.stringify(w.response) : "";
      return textResult(body === "" ? w.summary : `${w.summary}\n${body}`, w.response);
    },
  });

  pi.registerTool({
    name: "hbmon_status",
    label: "hbmon status",
    description:
      "Sock'lu build'in anlık özeti (ağaç+metrik+sağlık). Hızlı yoklama, beklemez. hbmon_wait `woke_on=... state=running/stalled` dönerse detaya bununla bak.",
    parameters: StatusParams,
    async execute(_id, params) {
      const s = await statusBuild(bin, params.sock);
      if (!s.response) return textResult(`hbmon_status BAŞARISIZ: ${s.error}`);
      return textResult(JSON.stringify(s.response), s.response);
    },
  });
}
