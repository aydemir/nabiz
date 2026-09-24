/**
 * hbmon custom tool'larının motoru (TASK-126).
 *
 * hbmon CLI'yi shell'siz (execFile, argv dizisi) çalıştırır: argüman
 * enjeksiyonu yok, Windows'ta da çalışır. Çıktı JSON parse edilir;
 * ikilik yoksa kurulum ipucu döner (öldürmez — ajan başka yola sapar).
 *
 * Kural: bu modül opencode'a dokunmaz (saf runner); plugin dosyası
 * (`plugins/opencode-hbmon.ts`) sadece `default` export eder (TASK-111).
 */

import { execFile } from "node:child_process"

export const HBMON_INSTALL_HINT =
  "hbmon bulunamadı. Kurulum: cargo install hbmon " +
  "(veya HBMON_BIN=/yol/hbmon; git'ten: cargo install --git https://github.com/aydemir/hbmon)"

/** İkilik çözümleme: boş-olmayan HBMON_BIN, yoksa PATH'teki `hbmon`. */
export function resolveHbmonBin(env: NodeJS.ProcessEnv = process.env): string {
  const direct = (env.HBMON_BIN ?? "").trim()
  return direct === "" ? "hbmon" : direct
}

export interface HbmonRun {
  /** Süreç çıkış kodu (hbmon sözleşmesi: 0/1/2/3/124…). */
  code: number
  /** stdout (kırpılmış). */
  stdout: string
  /** stderr (kırpılmış). */
  stderr: string
  /** stdout JSON ise parse edilmiş hali. */
  json?: unknown
  /** spawn/timeout seviyesi hata (ikilik yok, zaman aşımı…). */
  error?: string
}

function parseJson(text: string): unknown | undefined {
  const t = text.trim()
  if (t === "") return undefined
  try {
    return JSON.parse(t)
  } catch {
    // handshake dışı satırlar (build çıktısı karışmış olabilir):
    // ilk JSON satırını dene.
    for (const line of t.split("\n")) {
      const s = line.trim()
      if (s.startsWith("{")) {
        try {
          return JSON.parse(s)
        } catch {
          continue
        }
      }
    }
    return undefined
  }
}

/** hbmon'u çalıştır, çıktıyı topla. Shell yok — argv aynen taşınır. */
export function runHbmon(
  bin: string,
  args: string[],
  execTimeoutMs = 70000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HbmonRun> {
  // Dar istisna: Windows'ta .cmd/.bat ikamesi (yalnızca test shim'leri;
  // gerçek hbmon her zaman .exe). Node .cmd'yi doğrudan spawn edemez
  // (EINVAL); cmd.exe DOĞRUDAN spawn edilir (gerçek .exe, shell:false),
  // batch + argümanlar AYRI argv elemanı taşınır. TEK /c metni formu
  // BOZUKTUR (son argüman tırnaklıysa satır parçalanır — ölçüldü);
  // alıntılamayı Node'un CreateProcess kuruluşu yapar, el yapımı yok.
  let file = bin
  let spawnArgs = args
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    file = process.env.ComSpec ?? "cmd.exe"
    spawnArgs = ["/d", "/c", bin, ...args]
  }
  return new Promise((resolve) => {
    execFile(
      file,
      spawnArgs,
      { encoding: "utf8", timeout: execTimeoutMs, windowsHide: true, env },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "")
        const errText = String(stderr ?? "")
        if (err && typeof (err as NodeJS.ErrnoException).code === "string") {
          const code = (err as NodeJS.ErrnoException).code
          if (code === "ENOENT") {
            resolve({ code: 127, stdout: out, stderr: errText, error: HBMON_INSTALL_HINT })
            return
          }
        }
        const killed = !!err && (err as Error & { killed?: boolean }).killed === true
        const exitCode =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code as number)
            : 0
        resolve({
          code: exitCode,
          stdout: out,
          stderr: errText,
          json: parseJson(out),
          ...(killed ? { error: `hbmon çağrısı zaman aşımı (${execTimeoutMs}ms)` } : {}),
        })
      },
    )
  })
}

export interface WatchHandshake {
  uuid: string
  sock: string
  log: string
}

/** `watch --detach` → handshake. Başarısızlıkta error metni döner. */
export async function watchBuild(
  bin: string,
  command: string[],
  opts: { uuid?: string; timeoutSec?: number; label?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ handshake?: WatchHandshake; raw: HbmonRun; error?: string }> {
  const args = ["watch", "--detach"]
  if (opts.uuid) args.push("--uuid", opts.uuid)
  if (opts.label) args.push("--label", opts.label)
  if (opts.timeoutSec !== undefined) args.push("--timeout-sec", String(opts.timeoutSec))
  args.push("--", ...command)
  const raw = await runHbmon(bin, args, 30000, opts.env)
  if (raw.error) return { raw, error: raw.error }
  const j = raw.json as Partial<WatchHandshake> | undefined
  if (raw.code !== 0 || !j || typeof j.uuid !== "string" || typeof j.sock !== "string") {
    return { raw, error: `hbmon watch başarısız (exit ${raw.code}): ${(raw.stderr || raw.stdout).trim().slice(0, 300)}` }
  }
  return { handshake: { uuid: j.uuid, sock: j.sock, log: typeof j.log === "string" ? j.log : "" }, raw }
}

export interface WaitResult {
  /** Daemon yanıtı (ham JSON). */
  response?: unknown
  /** Kısa ajan cümlesi: `done code=0 in 38.5s`, `woke_on=dep_missing …`. */
  summary: string
  error?: string
}

/**
 * `wait` → terminal veya `until` erken-dönüşü.
 * daemonTimeoutSec: daemon-içi tavan (default 50 — gateway kesintisi altı,
 * ajan tekrar çağırır). exec tavanı = daemon + 15sn marj.
 */
export async function waitBuild(
  bin: string,
  sock: string,
  opts: { timeoutSec?: number; until?: string; env?: NodeJS.ProcessEnv; startupGraceMs?: number } = {},
): Promise<WaitResult> {
  const daemonTimeout = opts.timeoutSec ?? 50
  const args = ["wait", "--sock", sock, "--timeout", String(daemonTimeout)]
  if (opts.until) args.push("--until", opts.until)
  const execMs = (daemonTimeout + 15) * 1000
  const deadline = Date.now() + (opts.startupGraceMs ?? 10000)
  let raw = await runHbmon(bin, args, execMs, opts.env)
  while (!raw.json && isConnectionError(raw) && Date.now() < deadline) {
    await sleep(250)
    raw = await runHbmon(bin, args, execMs, opts.env)
  }
  if (raw.error) return { summary: raw.error, error: raw.error }
  const r = raw.json as Record<string, unknown> | undefined
  if (!r || typeof r !== "object") {
    return { summary: `hbmon wait parse edilemedi (exit ${raw.code})`, error: "bad json" }
  }
  return { response: r, summary: summarizeWait(r, raw.code) }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/**
 * Daemon-startup yarışı: re-exec + pipe bind ~yüzlerce ms sürer; ilk
 * istek "bağlanamadı" ile düşebilir. Bağlantı hatalarında zarif süre
 * dolana dek 250ms arayla tekrar dene (unix caller'larındaki
 * wait_for_ready deseni). Gerçek hatalar (parse, timeout) ilk seferde döner.
 */
function isConnectionError(raw: HbmonRun): boolean {
  if (raw.code !== 3) return false
  const text = `${raw.stderr}\n${raw.stdout}`
  return /pipe (wait|connect)|connect /i.test(text)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}

/** Tek-satır ajan özeti (context'e giren tek cümle budur). */
export function summarizeWait(r: Record<string, unknown>, exitCode: number): string {
  const woke = str(r.woke_on)
  const state = str(r.state)
  const code = num(r.code) ?? exitCode
  const dur = num(r.duration_sec)
  const durText = dur === undefined ? "" : ` in ${dur.toFixed(1)}s`
  if (r.timeout === true) return `timeout (hâlâ çalışıyor)${durText} — tekrar hbmon_wait çağır`
  if (woke && (state === "running" || state === "stalled") && r.code === undefined) {
    return `woke_on=${woke} state=${state}${durText} — hbmon_status ile detaya bak`
  }
  if (state === "done") return `done code=${code}${durText}`
  if (state === "dep_missing") return `dep_missing (exit 2)${durText} — log'a bak, bitmesini bekleme`
  if (state === "failed") return `failed code=${code}${durText}`
  if (state !== "") return `${state} code=${code}${durText}`
  return `wait exit=${exitCode}${durText}`
}

/** `status` → ham JSON yanıt (parse edilemezse error). */
export async function statusBuild(
  bin: string,
  sock: string,
  env: NodeJS.ProcessEnv = process.env,
  startupGraceMs = 10000,
  compact = false,
): Promise<{ response?: unknown; error?: string }> {
  const statusArgs = ["status", "--sock", sock]
  if (compact) statusArgs.push("--compact")
  let raw = await runHbmon(bin, statusArgs, 30000, env)
  const deadline = Date.now() + startupGraceMs
  while (!raw.json && isConnectionError(raw) && Date.now() < deadline) {
    await sleep(250)
    raw = await runHbmon(bin, statusArgs, 30000, env)
  }
  if (raw.error) return { error: raw.error }
  if (!raw.json || typeof raw.json !== "object") {
    return { error: `hbmon status parse edilemedi (exit ${raw.code})` }
  }
  return { response: raw.json }
}
