/**
 * Truncation Noticer — paylaşılan sabitler ve pure helper'lar.
 *
 * Bu dosya opencode plugin modülü tarafından iterate edilir
 * (`getLegacyPlugins` — Object.values(mod) üzerinden), dolayısıyla
 * plugin dosyası `default` dışında hiçbir şey export etmemeli.
 * Sabitler ve utility'ler burada toplanır.
 *
 * plugins/opencode-truncation-noticer.ts bu dosyayı import eder.
 * Testler de doğrudan buradan import eder (dist üzerinden).
 */

import { isAbsolute, resolve } from "node:path"

export const MARKER_SENTINEL = "[tn] truncated:"
export const DISCLOSURE_SENTINEL = "[tn-disclosed]"
export const DEFAULT_SKIP_CONTAINS = "#no-trunc-notice"

export const DISCLOSURE_TEXT =
  `[tn-disclosed] Truncation Noticer is active. Native \`read\` output lines ` +
  `look like "<lineNo>\\t<line>" — if the last line number is below the file's ` +
  `total, the output stopped mid-file and a marker like ` +
  `"[tn] truncated: X more lines after line N (of T total). Re-read with ` +
  `offset=N+1 limit=200, OR use bash_raw: sed -n 'N+1,Tp' <path>" will be ` +
  `appended. Never assume a truncated read is the full file — follow the ` +
  `marker's offset/sed (copy-paste ready). To disable this plugin entirely, set ` +
  `"pluginOptions.opencode-truncation-noticer.enabled": false` +
  ` in opencode.jsonc. To bypass per-call, embed "${DEFAULT_SKIP_CONTAINS}" ` +
  `in the read args.`

export function countLines(text: string): number {
  if (text.length === 0) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++
  }
  if (text.charCodeAt(text.length - 1) === 10) n--
  return n
}

export function parseLastLineNo(output: string, sep: string = "\t"): number {
  if (output.length === 0) return 0
  const lines = output.split("\n")
  let last = 0
  for (const line of lines) {
    const tabIdx = line.indexOf(sep)
    if (tabIdx <= 0) continue
    const n = Number(line.slice(0, tabIdx))
    if (Number.isFinite(n) && n > 0 && Math.floor(n) === n) {
      last = Math.max(last, n)
    }
  }
  return last
}

export function buildMarker(
  lastLineNo: number,
  totalLines: number,
  filePath: string,
  nextOffset: number,
): string {
  const remaining = totalLines - lastLineNo
  const cmdHint = `sed -n '${nextOffset},${totalLines}p' ${filePath}`
  return (
    `\n\n[tn] truncated: ${remaining} more lines after line ${lastLineNo} ` +
    `(of ${totalLines} total). Re-read with offset=${nextOffset} limit=200, ` +
    `OR use bash_raw: ${cmdHint}\n`
  )
}

export function resolveFilePath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null
  try {
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
  } catch {
    return null
  }
}