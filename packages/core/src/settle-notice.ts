/**
 * Settle Noticer — paylaşılan sabitler ve helper'lar.
 *
 * Bu dosya opencode plugin modülü tarafından iterate edilir
 * (`getLegacyPlugins` — Object.values(mod) üzerinden), dolayısıyla
 * plugin dosyası (`plugins/opencode-settle-noticer.ts`) `default`
 * dışında hiçbir şey export etmemeli. Sabitler ve utility'ler burada
 * toplanır (TASK-111 pattern'i).
 *
 * Sorumluluk: build-mon event dizinlerindeki (`*.status.json`) final
 * olayları bulup tek-seferlik bildirim metni üretmek. Wakeup YOK —
 * next-contact notice (TASK-123).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

export const NOTICE_SENTINEL = "[sn] settled:"
export const STALE_SENTINEL = "[sn] stale:"
export const DISCLOSURE_SENTINEL = "[sn-disclosed]"
export const DEFAULT_SKIP_CONTAINS = "#no-settle-notice"
export const DEFAULT_MAX_FILES = 20
/**
 * Bayatlık eşiği default'u: 180sn = 3 × build-mon default heartbeat (60sn).
 * Gerekçe: hook timer'la değil tool-sonucuyla çalışır (next-contact), yani
 * gözlem zaten geç kalır; 2 aralıktan kısa eşik yavaş tick'te flap üretir.
 */
export const DEFAULT_STALE_AFTER_MS = 180000

export const DISCLOSURE_TEXT =
  `[sn-disclosed] Settle Noticer is active. When a build monitored by ` +
  `scripts/build-mon.mjs settles (PASSED/FAILED/ERROR/TIMED_OUT/STALLED-kill/` +
  `INTERRUPTED), a one-line note like "[sn] settled: <name> <EVENT> ` +
  `(exit=<code>)" is appended to your next tool result — you do not need ` +
  `to ask or poll events.jsonl. Notices fire once per final (tracked ` +
  `with per-build .notified marker files). It does NOT wake an idle ` +
  `session, it surfaces ` +
  `on next contact. Event dirs come from config eventDirs, else ` +
  `$BUILD_MON_DIR and <cwd>/tmp/build-mon (existing dirs only). ` +
  `Long builds default: scripts/build-mon.mjs --name <id> -- <cmd>; ` +
  `result in tmp/build-mon/<id>.status.json via this notice. ` +
  `ON NOTICE: read the cited status.json path + its log file, then report ` +
  `the verdict — do not re-poll events.jsonl. ` +
  `hbmon-watched builds are NOT covered here; await those with hbmon_wait. ` +
  `cpu-liveness-agent is only a second layer for CPU-bound + --allow-kill. ` +
  `Builds gone silent without a final (stale heartbeat, default 180s) get ` +
  `a one-time "[sn] stale:" note instead — a dead monitor is suspected. ` +
  `To disable entirely, set ` +
  `"pluginOptions.opencode-settle-noticer.enabled": false` +
  ` in opencode.jsonc. To bypass per-call, embed "${DEFAULT_SKIP_CONTAINS}" ` +
  `in the tool args.`

export interface SettleRecord {
  name: string
  event: string
  ts: string
  exit: number | string
  detail: string
  log: string
  statusPath: string
}

/**
 * status.json dosyasını parse et. Bozuk/eksik/yanlış şekilli dosyada null
 * (graceful — yarım yazılmış dosyalar bildirimi düşürmez).
 */
export function parseStatusFile(path: string): SettleRecord | null {
  let raw: unknown
  try {
    if (!existsSync(path)) return null
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r["name"] !== "string" || typeof r["event"] !== "string") return null
  if (typeof r["ts"] !== "string") return null
  if (typeof r["exit"] !== "number" && typeof r["exit"] !== "string") return null
  return {
    name: r["name"] as string,
    event: r["event"] as string,
    ts: r["ts"] as string,
    exit: r["exit"] as number | string,
    detail: typeof r["detail"] === "string" ? (r["detail"] as string) : "",
    log: typeof r["log"] === "string" ? (r["log"] as string) : "",
    statusPath: path,
  }
}

/**
 * Final mi? build-mon tüm finallerde `exit` yazar (emit code parametresi);
 * HEARTBEAT / STALLED-uyarı / STARTED yazmaz. Olay-adı listesi yok.
 */
export function isFinal(rec: SettleRecord): boolean {
  return rec.exit !== undefined && rec.exit !== null && rec.exit !== ""
}

/** Bildirim işareti: <eventDir>/<name>.notified (içerik: "<ts> <event>"). */
export function notifiedPath(eventDir: string, name: string): string {
  return join(eventDir, `${name}.notified`)
}

export function isNotified(eventDir: string, rec: SettleRecord): boolean {
  try {
    const marker = readFileSync(notifiedPath(eventDir, rec.name), "utf8").trim()
    return marker === `${rec.ts} ${rec.event}`
  } catch {
    return false
  }
}

/** Best-effort işaretle (yazma hatası bildirimi engellemez). */
export function markNotified(eventDir: string, rec: SettleRecord): void {
  try {
    writeFileSync(notifiedPath(eventDir, rec.name), `${rec.ts} ${rec.event}\n`, "utf8")
  } catch {
    // yut — bir sonraki temasta tekrar bildirilir, kayıp yok
  }
}

/**
 * Event dizinlerini çöz: explicit liste varsa o (var olanlar), yoksa
 * $BUILD_MON_DIR + <cwd>/tmp/build-mon (var olanlar). Yoksa [].
 */
export function resolveEventDirs(
  explicit?: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string[] {
  const candidates: string[] =
    explicit && explicit.length > 0
      ? explicit
      : [env["BUILD_MON_DIR"] ?? "", join(cwd, "tmp", "build-mon")]
  const out: string[] = []
  for (const c of candidates) {
    if (typeof c !== "string" || c.length === 0) continue
    try {
      const abs = resolve(c)
      if (existsSync(abs) && !out.includes(abs)) out.push(abs)
    } catch {
      continue
    }
  }
  return out
}

/**
 * Dizinlerdeki bildirilmemiş finalleri tara. Bounded (dizin başına en fazla
 * maxFiles status dosyası), hataya dayanıklı (yok/okunamaz dizin → atla).
 * Sonuç ts'e göre eskiden yeniye sıralı.
 */
export function scanSettled(eventDirs: string[], maxFiles: number = DEFAULT_MAX_FILES): SettleRecord[] {
  const found: { rec: SettleRecord; dir: string }[] = []
  for (const dir of eventDirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    const statusFiles = entries
      .filter((f) => f.endsWith(".status.json"))
      .sort()
      .slice(0, Math.max(0, maxFiles))
    for (const f of statusFiles) {
      const rec = parseStatusFile(join(dir, f))
      if (!rec || !isFinal(rec)) continue
      if (isNotified(dir, rec)) continue
      found.push({ rec, dir })
    }
  }
  found.sort((a, b) => (a.rec.ts < b.rec.ts ? -1 : a.rec.ts > b.rec.ts ? 1 : 0))
  return found.map((x) => x.rec)
}

/** Tek-seferlik bildirim metni (çıktı sonuna eklenir). */
export function buildNotice(records: SettleRecord[]): string {
  const lines = records.map(
    (r) => `${NOTICE_SENTINEL} ${r.name} ${r.event} (exit=${r.exit}) — ${r.detail} [${r.statusPath}]`,
  )
  return "\n\n" + lines.join("\n") + "\n"
}

/** Finalsız son-olay (bayatlık adayı). `exit` bilerek YOK sayılır. */
export interface LastEvent {
  name: string
  event: string
  ts: string
  statusPath: string
  /** Final mi? Finaller settle yoluna aittir, stale taraması atlar. */
  hasExit: boolean
}

/**
 * Son-olayı parse et (exit şartı YOK — finalsız dosyalar da okunur).
 * Bozuk/eksik/ts'siz dosyada null (graceful).
 */
export function parseLastEvent(path: string): LastEvent | null {
  let raw: unknown
  try {
    if (!existsSync(path)) return null
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r["name"] !== "string" || typeof r["event"] !== "string") return null
  if (typeof r["ts"] !== "string" || !Number.isFinite(Date.parse(r["ts"] as string))) return null
  const exit = r["exit"]
  return {
    name: r["name"] as string,
    event: r["event"] as string,
    ts: r["ts"] as string,
    statusPath: path,
    hasExit: exit !== undefined && exit !== null && exit !== "",
  }
}

export interface StaleRecord {
  name: string
  event: string
  ts: string
  ageMs: number
  statusPath: string
}

/** Bayatlık işareti: <eventDir>/<name>.stale-notified (içerik: "<ts> <event>"). */
export function staleNotifiedPath(eventDir: string, name: string): string {
  return join(eventDir, `${name}.stale-notified`)
}

export function isStaleNotified(eventDir: string, rec: Pick<StaleRecord, "name" | "ts" | "event">): boolean {
  try {
    const marker = readFileSync(staleNotifiedPath(eventDir, rec.name), "utf8").trim()
    return marker === `${rec.ts} ${rec.event}`
  } catch {
    return false
  }
}

/**
 * Yeni olay işareti sıfırlar: marker eski ts/event'i tutar, dosya ilerleyince
 * eşleşmezlikten bildirim yeniden hak kazanır. Ayrı reset mantığı YOK.
 */
export function markStaleNotified(eventDir: string, rec: Pick<StaleRecord, "name" | "ts" | "event">): void {
  try {
    writeFileSync(staleNotifiedPath(eventDir, rec.name), `${rec.ts} ${rec.event}\n`, "utf8")
  } catch {
    // yut — bir sonraki temasta tekrar bildirilir, kayıp yok
  }
}

/**
 * Finalsız + yaşlı build'leri tara (monitör-ölümü bayatlığı, TASK-131).
 * Bounded (dizin başına maxFiles), hataya dayanıklı, ts'ye göre sıralı.
 * `nowMs` enjekte edilebilir (test determinizmi).
 */
export function scanStale(
  eventDirs: string[],
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
  maxFiles: number = DEFAULT_MAX_FILES,
  nowMs: number = Date.now(),
): StaleRecord[] {
  const found: { rec: StaleRecord; dir: string }[] = []
  for (const dir of eventDirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    const statusFiles = entries
      .filter((f) => f.endsWith(".status.json"))
      .sort()
      .slice(0, Math.max(0, maxFiles))
    for (const f of statusFiles) {
      const ev = parseLastEvent(join(dir, f))
      if (!ev || ev.hasExit) continue
      const ageMs = nowMs - Date.parse(ev.ts)
      if (!Number.isFinite(ageMs) || ageMs <= staleAfterMs) continue
      if (isStaleNotified(dir, ev)) continue
      found.push({ rec: { name: ev.name, event: ev.event, ts: ev.ts, ageMs, statusPath: ev.statusPath }, dir })
    }
  }
  found.sort((a, b) => (a.rec.ts < b.rec.ts ? -1 : a.rec.ts > b.rec.ts ? 1 : 0))
  return found.map((x) => x.rec)
}

function formatStaleAge(ageMs: number): string {
  const s = Math.floor(ageMs / 1000)
  if (s < 60) return `${s}sn`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}dk`
  return `${Math.floor(m / 60)}sa`
}

/** Bayatlık bildirim metni (çıktı sonuna eklenir). */
export function buildStaleNotice(records: StaleRecord[]): string {
  const lines = records.map(
    (r) => `${STALE_SENTINEL} ${r.name} son olay ${r.event} ${formatStaleAge(r.ageMs)} önce (monitör sessiz — final yok) [${r.statusPath}]`,
  )
  return "\n\n" + lines.join("\n") + "\n"
}

/**
 * Disclosure eki: oturum açılışında bekleyen settlelari sistem prompt'una
 * gömer (snapshot semantiği — salt okunur, işaretleme yapmaz; bildirim +
 * işaretleme `tool.execute.after`'ın işi). Kayıt yoksa "".
 */
export function buildPendingSuffix(records: SettleRecord[]): string {
  if (records.length === 0) return ""
  return (
    " Pending settles: " +
    records.map((r) => `${r.name} ${r.event} (exit=${r.exit})`).join("; ") +
    "."
  )
}
