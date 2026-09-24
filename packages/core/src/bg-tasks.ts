/**
 * bg_* tool'larının saf mantığı (TASK-132).
 *
 * pi/nabız `bg-hbmon.ts` yüzeyinin opencode karşılığı, backend hbmon daemon.
 * Kural: bu modül opencode'a dokunmaz (saf fs+veri); plugin dosyası sadece
 * `default` export eder (TASK-111 getLegacyPlugins kuralı).
 *
 * Kalıcılık: sidecar `<dir>/bg-<uuid>.json` — daemon restart'larından sağ
 * çıkar (`hbmon list` ile birleşir). dir: HBMON_BG_DIR > os.tmpdir().
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface BgRecord {
  v: 1
  name: string
  uuid: string
  sock: string
  log: string
  out: string
  sessionID: string
  notify: boolean
  createdAt: string
}

/** Sidecar dizini: açık override yoksa hbmon platform convention (~tmpdir). */
export function bgDir(env: NodeJS.ProcessEnv = process.env): string {
  const direct = (env.HBMON_BG_DIR ?? "").trim()
  return direct === "" ? os.tmpdir() : direct
}

export function sidecarPath(dir: string, uuid: string): string {
  return path.join(dir, `bg-${uuid}.json`)
}

export function writeRecord(dir: string, rec: BgRecord): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(sidecarPath(dir, rec.uuid), JSON.stringify(rec, null, 2))
}

export function readRecord(dir: string, uuid: string): BgRecord | undefined {
  try {
    const raw = fs.readFileSync(sidecarPath(dir, uuid), "utf8")
    const r = JSON.parse(raw) as BgRecord
    if (r && r.v === 1 && typeof r.uuid === "string") return r
    return undefined
  } catch {
    return undefined
  }
}

export function listRecords(dir: string): BgRecord[] {
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith("bg-") && f.endsWith(".json"))
  } catch {
    return []
  }
  const out: BgRecord[] = []
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as BgRecord
      if (r && r.v === 1 && typeof r.uuid === "string") out.push(r)
    } catch {
      // bozuk sidecar atlanır
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
}

/**
 * id çözümleme: önce exact name, sonra uuid-prefix (sidecar'larda).
 * Belirsiz prefix (2+ eşleşme) → error.
 */
export function resolveRecord(
  dir: string,
  id: string,
): { record?: BgRecord; error?: string } {
  const all = listRecords(dir)
  if (all.length === 0) return { error: `bilinmeyen bg görevi: ${id} (kayıt yok)` }
  const byName = all.filter((r) => r.name === id)
  if (byName.length === 1) return { record: byName[0] }
  if (byName.length > 1) return { error: `'${id}' adlı ${byName.length} görev var, uuid prefix ver` }
  const byUuid = all.filter((r) => r.uuid.startsWith(id))
  if (byUuid.length === 1) return { record: byUuid[0] }
  if (byUuid.length > 1) {
    return { error: `'${id}' prefix'i ${byUuid.length} göreve uyuyor: ${byUuid.map((r) => r.uuid.slice(0, 8)).join(", ")}` }
  }
  return { error: `bilinmeyen bg görevi: ${id}` }
}

/** .out kuyruğu: en fazla maxBytes (default 50KB, pi bg-hbmon ile aynı cap). */export function readOutTail(outPath: string, maxBytes = 50 * 1024): { text: string; truncated: boolean } {
  let st: fs.Stats
  try {
    st = fs.statSync(outPath)
  } catch {
    return { text: `(çıktı yok: ${outPath})`, truncated: false }
  }
  const fd = fs.openSync(outPath, "r")
  try {
    const start = Math.max(0, st.size - maxBytes)
    const buf = Buffer.alloc(Math.min(st.size, maxBytes))
    fs.readSync(fd, buf, 0, buf.length, start)
    return { text: buf.toString("utf8"), truncated: start > 0 }
  } finally {
    fs.closeSync(fd)
  }
}

export interface OutCursor {
  text: string
  nextOffset: number
  size: number
  truncated: boolean
}

export const OUT_CURSOR_CAP = 50 * 1024

/**
 * .out artımlı okuma (NABIZ-001 cursor protokolü): `[offset, offset+len)` aralığı.
 * - Negatif/NaN offset → 0'a clamp; len üst sınırı OUT_CURSOR_CAP.
 * - `offset > size` → `{ text: "", nextOffset: size }` (cursor EOF'a sabitlenir).
 * - UTF-8 bayt kesimi olduğu gibi bırakılır (tail ile aynı trade-off).
 */
export function readOutCursor(outPath: string, offset: number, maxBytes = OUT_CURSOR_CAP): OutCursor {
  let off = Number.isFinite(offset) ? Math.floor(offset) : 0
  if (off < 0) off = 0
  const len = Math.max(1, Math.min(Math.floor(maxBytes), OUT_CURSOR_CAP))
  let st: fs.Stats
  try {
    st = fs.statSync(outPath)
  } catch {
    return { text: `(çıktı yok: ${outPath})`, nextOffset: 0, size: 0, truncated: false }
  }
  if (off > st.size) return { text: "", nextOffset: st.size, size: st.size, truncated: false }
  const fd = fs.openSync(outPath, "r")
  try {
    const n = Math.min(len, st.size - off)
    const buf = Buffer.alloc(n)
    fs.readSync(fd, buf, 0, n, off)
    const nextOffset = off + n
    return { text: buf.toString("utf8"), nextOffset, size: st.size, truncated: nextOffset < st.size }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Cursor makbuzu (iki harness'te aynı metin): başlık + devam ipucu + metin.
 * Metinsiz EOF → `(yeni çıktı yok)` satırı.
 */
export function formatCursorReceipt(
  name: string,
  offset: number,
  cur: Pick<OutCursor, "nextOffset" | "size" | "truncated">,
  text: string,
): string {
  const head = `[${name} .out offset=${offset} next_offset=${cur.nextOffset} size=${cur.size}${cur.truncated ? " TRUNCATED, devamı var" : ""}]`
  if (text === "") return `${head}\n(yeni çıktı yok)`
  const hint = cur.truncated ? `(devamı için offset=${cur.nextOffset} ile tekrar çağır)\n` : ""
  return `${head}\n${hint}${text}`
}

export interface OffsetTracker {
  /** İstenen offset'i kaydeder; aynı offset üst üste okunursa true (tekrar). */
  note(taskId: string, offset: number): boolean
  /** Task bitince/öldürülünce çağrılır (bellek sızıntısı yok). */
  forget(taskId: string): void
}

/** Tekrar-okuma tespiti (NABIZ-001 §4): saklanan İSTENEN offset'tir. */
export function createOffsetTracker(): OffsetTracker {
  const last = new Map<string, number>()
  return {
    note(taskId, offset) {
      const prev = last.get(taskId)
      last.set(taskId, offset)
      return prev !== undefined && prev === offset
    },
    forget(taskId) {
      last.delete(taskId)
    },
  }
}

/** sock yolundan .out türetme (sidecar yoksa fallback). */
export function outFromSock(sock: string): string {
  return sock.endsWith(".sock") ? sock.slice(0, -5) + ".out" : sock + ".out"
}

/** Wake mesajı: bekçinin `opencode run -s` ile enjekte ettiği tek satır. */
export function wakeMessage(name: string, state: string, code: number | undefined): string {
  const c = code === undefined ? "?" : String(code)
  return `[bg] ${name} → ${state} (exit ${c}). bg_status/bg_logs ile detaya bak.`
}

export interface LogEvent {
  ev: string
  state?: string
  code?: number
  duration_sec?: number
}

/**
 * .jsonl kuyruğundan son olay (daemon ölmüş/kapanmış monitör fallback'i).
 * Bekçi + bg_status, `wait`/`status` boş dönerse buradan terminal state okur.
 */
export function readLastEvent(logPath: string, tailBytes = 8192): LogEvent | undefined {
  let st: fs.Stats
  try {
    st = fs.statSync(logPath)
  } catch {
    return undefined
  }
  if (st.size === 0) return undefined
  const fd = fs.openSync(logPath, "r")
  try {
    const start = Math.max(0, st.size - tailBytes)
    const buf = Buffer.alloc(Math.min(st.size, tailBytes))
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString("utf8").split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim()
      if (!t.startsWith("{")) continue
      try {
        const j = JSON.parse(t) as LogEvent
        if (j && typeof j.ev === "string") return j
      } catch {
        continue
      }
    }
    return undefined
  } finally {
    fs.closeSync(fd)
  }
}

/** Terminal state mi (bekçi uyandırır / status final sayar)? */
export function isTerminalState(state: string | undefined): boolean {
  return state === "done" || state === "failed" || state === "dep_missing"
}
