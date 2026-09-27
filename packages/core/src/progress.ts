/**
 * nabiz-core/progress — build-mon ara-durum okuma (NABIZ-005).
 *
 * Karar: YENİ dosya YOK, `events.jsonl` reuse edilir. `build-mon.mjs` ve
 * `hbmon-build-mon.mjs` zaten aynı kayda yazar:
 *   { ts, name, event, detail, log, exit? }
 * olaylar: STARTED / HEARTBEAT / STALLED / TIMED_OUT / OOM_SUSPECT /
 *   DEP_MISSING / PASSED / FAILED / ERROR / INTERRUPTED.
 *
 * Tüketici: MCP `bg_status` zenginleştirmesi (3 seçenekten seçilen).
 * Reddedilenler: `/api/event` köprüsü (tüketici sözleşmesi repo'da yok,
 * TUI kodu bizde değil), notice dosyası (pasif; prompt disiplini ister —
 * KANBAN kilidine aykırı: disiplin runtime'da tutulur).
 *
 * Kilit: polling YOK — bu modül SADECE okur (tail + tara). `setInterval`,
 * `setTimeout`, izleyici döngü YOK. `events.jsonl` yoksa sessiz `undefined`
 * (fail-open) — çağıran bugünkü çıktısını aynen verir.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs"
import { join } from "node:path"

export interface ProgressRecord {
  ts: string
  name: string
  event: string
  detail: string
  exit?: number | string
}

const TAIL_BYTES_DEFAULT = 32 * 1024

/** Tek satırı doğrula; bozuk satır → null (atla, patlama). */
export function parseProgressLine(line: string): ProgressRecord | null {
  const s = line.trim()
  if (s === "") return null
  let o: unknown
  try {
    o = JSON.parse(s)
  } catch {
    return null
  }
  if (o === null || typeof o !== "object") return null
  const r = o as Record<string, unknown>
  if (typeof r.ts !== "string" || typeof r.name !== "string") return null
  if (typeof r.event !== "string" || typeof r.detail !== "string") return null
  const rec: ProgressRecord = {
    ts: r.ts,
    name: r.name,
    event: r.event,
    detail: r.detail,
  }
  if (typeof r.exit === "number" || typeof r.exit === "string") rec.exit = r.exit
  return rec
}

function readTail(path: string, maxBytes: number): string {
  const size = statSync(path).size
  const start = Math.max(0, size - maxBytes)
  const fd = openSync(path, "r")
  try {
    const len = size - start
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, start)
    return buf.toString("utf8")
  } finally {
    closeSync(fd)
  }
}

/**
 * `name` ile eşleşen SON ilerleme kaydı (tüm event-dizinleri taranır).
 * Yoksa / dizin yoksa / dosya yoksa → undefined (fail-open).
 */
export function readLastProgress(
  eventDirs: string[],
  name: string,
  tailBytes = TAIL_BYTES_DEFAULT,
): ProgressRecord | undefined {
  let best: ProgressRecord | undefined
  for (const dir of eventDirs) {
    const p = join(dir, "events.jsonl")
    let text: string
    try {
      if (!existsSync(p)) continue
      text = readTail(p, tailBytes)
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      const rec = parseProgressLine(line)
      if (rec && rec.name === name) best = rec
    }
  }
  return best
}

/** Tek satırlık özet: `progress: <EVENT> (<ts>): <detail>[ (exit=N)]`. */
export function formatProgress(rec: ProgressRecord): string {
  const exit = rec.exit !== undefined ? ` (exit=${rec.exit})` : ""
  return `progress: ${rec.event} (${rec.ts}): ${rec.detail}${exit}`
}
