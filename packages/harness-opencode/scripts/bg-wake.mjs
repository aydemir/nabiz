#!/usr/bin/env node
/**
 * bg-wake.mjs (TASK-132) — bg görev bekçisi.
 *
 * `bg_run` tarafından detached spawn edilir (stdio ignore, unref):
 * hbmon `wait` ile gobekler, terminal state'te (done/failed/dep_missing)
 * `opencode run -s <session> "[bg] ..."` koşarak AYNI oturuma enjeksiyon
 * dener (pi triggerTurn karşılığı — headless kanıt: /tmp/opencode-wake-test;
 * TUI eşzamanlılığı + persistence/scheduler wake ölçülmedi). CLI kabulü
 * yeni turn garantisi vermez.
 *
 * Busy-safe adapter (--task-id ile): `opencode export <session>` poll
 * edilir; marker persistence + yeni assistant turn
 * (assistant.time.created > injection_ts) doğrulanır. Persistence var +
 * turn yoksa backoff ile tekrar enjekte edilir (busy-drop şüphesi:
 * Runner meşgulken yeni work düşer). Sonuç JSONL attempt log'a yazılır.
 * hbmon'a ve OpenCode scheduler'a dokunulmaz.
 *
 * Kullanım:
 *   node scripts/bg-wake.mjs --session <id> --sock <sock> --name <ad>
 *     [--bin hbmon] [--wait-sec 300] [--max-wait-sec 14400] [--dry-run]
 *     [--task-id <id>] [--verify-timeout-sec 120] [--poll-sec 5]
 *     [--persist-gap-sec 20] [--max-injections 3] [--backoff-sec 15]
 *     [--attempt-log <path>]
 *
 * Çıkış (--task-id YOK, legacy): 0 CLI enjeksiyonu kabul
 * (teslim değil — yeni turn garantisi yok), 2 process bütçesi bitti
 * (enjeksiyon denenmeden çık), 1 hata.
 * Çıkış (--task-id VAR, adapter): 0 wake=confirmed (veya already-confirmed),
 * 1 wake=unknown / injection=failed, 2 hiçbir enjeksiyon denenemeden bütçe
 * bitti. Ayrıntı stdout + attempt log'dadır.
 * --dry-run: beklemez, enjekte edilecek komutu yazıp 0 döner.
 */
import { execFile } from "node:child_process"
import * as fs from "node:fs"

const args = process.argv.slice(2)
const get = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d
}
const SESSION = get("--session", "")
const SOCK = get("--sock", "")
const NAME = get("--name", "bg")
const LOG = get("--log", SOCK.endsWith(".sock") ? SOCK.slice(0, -5) + ".jsonl" : "")
const BIN = get("--bin", process.env.HBMON_BIN || "hbmon")
const WAIT_SEC = Number(get("--wait-sec", "30"))
const MAX_WAIT_SEC = Number(get("--max-wait-sec", "14400"))
const DRY = args.includes("--dry-run")
const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : d
}
// --- busy-safe adapter ayarları (sıra 10: hbmon/scheduler'a dokunulmaz) ---
const TASK_ID = get("--task-id", "")
const VERIFY_TIMEOUT_SEC = num(get("--verify-timeout-sec", "120"), 120)
const POLL_SEC = num(get("--poll-sec", "5"), 5)
const PERSIST_GAP_SEC = num(get("--persist-gap-sec", "20"), 20)
const MAX_INJECTIONS = Math.max(1, Math.floor(num(get("--max-injections", "3"), 3)))
const BACKOFF_SEC = num(get("--backoff-sec", "15"), 15)
const ATTEMPT_LOG = get("--attempt-log", SOCK.endsWith(".sock") ? SOCK.slice(0, -5) + ".attempts.jsonl" : "")
// (1) retry'lar aynı marker/taskId semantiğini korur: denemeler JSONL'deki
// injection_ts'lerle, turn'ler created zamanlarıyla ayrışır.
const MARKER = TASK_ID ? `[wake:${TASK_ID}]` : ""

if (!SESSION || !SOCK) {
  console.error("kullanim: bg-wake.mjs --session <id> --sock <sock> [--name <ad>] [--dry-run]")
  process.exit(1)
}

function run(file, a, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, a, { encoding: "utf8", timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
    })
  })
}

function lastState(text) {
  // wait çıktısı tek JSON; yine de son JSON satırı tara.
  const lines = text.trim().split("\n").reverse()
  for (const ln of lines) {
    const t = ln.trim()
    if (!t.startsWith("{")) continue
    try {
      const j = JSON.parse(t)
      if (j && typeof j === "object" && typeof j.state === "string") return j
    } catch { /* devam */ }
  }
  return null
}

const TERMINAL = new Set(["done", "failed", "dep_missing"])

/** .jsonl kuyruğundan son olay — daemon ölmüşse bile terminal state verir. */
function lastLogEvent() {
  if (!LOG) return null
  let st
  try {
    st = fs.statSync(LOG)
  } catch {
    return null
  }
  if (st.size === 0) return null
  const fd = fs.openSync(LOG, "r")
  try {
    const start = Math.max(0, st.size - 8192)
    const buf = Buffer.alloc(Math.min(st.size, 8192))
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString("utf8").split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim()
      if (!t.startsWith("{")) continue
      try {
        const j = JSON.parse(t)
        if (j && typeof j.ev === "string") return j
      } catch { /* devam */ }
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}

function logAttempt(rec) {
  if (!ATTEMPT_LOG) return
  try {
    fs.appendFileSync(
      ATTEMPT_LOG,
      JSON.stringify({ ts: new Date().toISOString(), task: TASK_ID || NAME, ...rec }) + "\n",
    )
  } catch { /* best-effort */ }
}

async function inject(state, code) {
  const base = `[bg] ${NAME} → ${state} (exit ${code ?? "?"}). bg_status/bg_logs ile detaya bak.`
  const msg = MARKER ? `${base} ${MARKER}` : base
  const injection_ts = Date.now()
  const d = await run("opencode", ["run", "-s", SESSION, msg], 180000)
  if (d.err) {
    console.error(`bg-wake: enjeksiyon başarısız: ${d.err.message ?? d.err} | stderr: ${d.stderr.slice(0, 300)}`)
    return { ok: false, ts: injection_ts }
  }
  console.log(`bg-wake: injection-attempt: ${NAME} ${state} (CLI kabul — yeni turn garantisi yok)`)
  return { ok: true, ts: injection_ts }
}

/** `opencode export <session>` — persistence + turn doğrulama kaynağı
 *  (status endpoint keşfi zorunlu bağımlılık değildir). */
async function readExport() {
  const d = await run("opencode", ["export", SESSION], 60000)
  if (d.err) return { ok: false, error: String(d.err.message ?? d.err) }
  try {
    const j = JSON.parse(d.stdout)
    const messages = Array.isArray(j?.messages) ? j.messages : []
    return { ok: true, messages }
  } catch (e) {
    return { ok: false, error: `export parse: ${e?.message ?? e}` }
  }
}

function msgCreated(m) {
  const t = m?.info?.time?.created ?? m?.info?.timestamp ?? 0
  return typeof t === "number" ? t : 0
}

function msgText(m) {
  try {
    return JSON.stringify(m?.parts ?? m)
  } catch {
    return ""
  }
}

function markerUsers(messages) {
  if (!MARKER) return []
  return messages.filter((m) => m?.info?.role === "user" && msgText(m).includes(MARKER))
}

function turnAfter(messages, ts) {
  const turns = messages
    .filter((m) => m?.info?.role === "assistant" && msgCreated(m) > ts)
    .sort((a, b) => msgCreated(a) - msgCreated(b))
  return turns[0]
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

/**
 * Busy-safe injection + wake verification (sıra 1-9).
 * 0 = wake confirmed/already-confirmed, 1 = unknown/failed,
 * 2 = hiçbir enjeksiyon denenemeden bütçe bitti.
 */
async function verifyLoop(state, code) {
  const t0 = Date.now()
  const waited = () => ((Date.now() - t0) / 1000).toFixed(1) + "s"
  // (8) idempotency pre-check: marker + sonrası turn zaten varsa yeni injection yok.
  try {
    const pre = await readExport()
    if (pre.ok && MARKER) {
      const users = markerUsers(pre.messages)
      if (users.length > 0) {
        const latestUser = Math.max(...users.map(msgCreated))
        const turn = turnAfter(pre.messages, latestUser)
        if (turn) {
          logAttempt({ event: "verify", wake: "already-confirmed", injections: 0, assistant_turn_ts: msgCreated(turn) })
          console.log(`bg-wake: wake=already-confirmed task=${TASK_ID} assistant_turn_ts=${msgCreated(turn)}`)
          return 0
        }
      }
    }
  } catch { /* pre-check best-effort; adapter devam eder */ }
  let injections = 0
  let okCount = 0
  let firstInjectTs = 0
  let lastAttemptEnd = 0
  const sightings = []
  for (;;) {
    if ((Date.now() - t0) / 1000 > VERIFY_TIMEOUT_SEC) break
    const snap = await readExport()
    let persisted = false
    let turn = undefined
    if (snap.ok && MARKER) {
      if (markerUsers(snap.messages).length > 0) {
        persisted = true
        if (sightings.length === 0 || Date.now() - sightings[sightings.length - 1] >= 1000) {
          sightings.push(Date.now())
        }
        if (okCount > 0) turn = turnAfter(snap.messages, firstInjectTs)
      }
    }
    if (turn) {
      // (5) assistant.time.created > injection_ts → wake=confirmed.
      logAttempt({
        event: "verify", wake: "confirmed", state, code, injections,
        injection: "ok", injection_ts: firstInjectTs,
        persistence: sightings.length >= 2 ? "ok" : "single-sighting",
        assistant_turn_ts: msgCreated(turn), waited_verify: waited(),
      })
      console.log(`bg-wake: wake=confirmed task=${TASK_ID} injections=${injections} assistant_turn_ts=${msgCreated(turn)}`)
      return 0
    }
    const quietOver = Date.now() - lastAttemptEnd >= BACKOFF_SEC * 1000
    // (6) retry kuralı: başarı yoksa dene; başarı + persistence + turn-yoksa
    // backoff sonrası tekrar dene (busy-drop şüphesi); başarı + persistence-yoksa
    // bekle (lag olabilir — kör enjeksiyon yapma).
    const needInject =
      okCount === 0
        ? injections === 0 || (injections < MAX_INJECTIONS && quietOver)
        : persisted && injections < MAX_INJECTIONS && quietOver
    if (needInject) {
      injections += 1
      const r = await inject(state, code)
      lastAttemptEnd = Date.now()
      if (r.ok) {
        okCount += 1
        if (!firstInjectTs) firstInjectTs = r.ts
      }
      // (9) her deneme JSONL injection-attempt olarak kaydedilir.
      logAttempt({
        event: "injection-attempt", attempt: injections, state, code,
        state_before: "unknown", injection: r.ok ? "ok" : "failed", injection_ts: r.ts,
      })
      if (!r.ok && injections >= MAX_INJECTIONS) break
    } else {
      await sleep(POLL_SEC * 1000)
    }
  }
  // (7) bütçe doldu → wake=unknown (asla wake=ok raporlanmaz).
  let persistence = "failed"
  if (sightings.length >= 2 && sightings[sightings.length - 1] - sightings[0] >= PERSIST_GAP_SEC * 1000) {
    persistence = "ok"
  } else if (sightings.length >= 1) {
    persistence = "unknown"
  }
  logAttempt({
    event: "verify", wake: "unknown", state, code, injections,
    injection: okCount > 0 ? "ok" : "failed", injection_ts: firstInjectTs || null,
    persistence, sightings: sightings.length, assistant_turn_ts: null, waited_verify: waited(),
  })
  console.log(`bg-wake: wake=unknown task=${TASK_ID} injections=${injections} persistence=${persistence}`)
  return okCount > 0 || injections > 0 ? 1 : 2
}

async function main() {
  if (DRY) {
    console.log(`opencode run -s ${SESSION} "[bg] ${NAME} → <state> (exit <code>). bg_status/bg_logs ile detaya bak."`)
    return 0
  }
  const t0 = Date.now()
  for (;;) {
    if ((Date.now() - t0) / 1000 > MAX_WAIT_SEC) {
      console.error(`bg-wake: bütçe bitti (${MAX_WAIT_SEC}sn), enjeksiyon denemeden çık: ${NAME}`)
      return 2
    }
    // 1) jsonl birincil: daemon/monitorsiz de terminal state verir.
    const ev = lastLogEvent()
    if (ev && TERMINAL.has(ev.state)) {
      if (TASK_ID) return await verifyLoop(ev.state, ev.code)
      return (await inject(ev.state, ev.code)).ok ? 0 : 1
    }
    // 2) wait hızlı yol (kısa tavan; yoklama jsonl'dan).
    const r = await run(BIN, ["wait", "--sock", SOCK, "--timeout", String(WAIT_SEC)], (WAIT_SEC + 60) * 1000)
    const j = lastState(r.stdout)
    if (j && !j.timeout && TERMINAL.has(j.state)) {
      if (TASK_ID) return await verifyLoop(j.state, j.code)
      return (await inject(j.state, j.code)).ok ? 0 : 1
    }
    await new Promise((res) => setTimeout(res, 5000))
  }
}

process.exit(await main())
