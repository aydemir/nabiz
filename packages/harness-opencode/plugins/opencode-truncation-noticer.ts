/**
 * opencode-truncation-noticer ("tn")
 *
 * OpenCode native `read` tool'unun sessiz kırpmasını gözlemler ve
 * modele "devamı var" marker'ı ekler. Bu, küçük context'li modeller
 * için yarım içerik üzerinden karar vermeyi engeller.
 *
 * Davranış:
 *   1. `tool.execute.after` hook'unda tool adı "read" ise çıktıyı
 *      parse et (`<lineNo>\t<line>` formatı).
 *   2. `input.filePath` + toplam satır sayısı (fs.readFileSync ile)
 *      karşılaştır: son satır no toplamdan küçükse → marker ekle.
 *   3. Marker formatı:
 *        [tn] truncated: X more lines after line N (of T total).
 *             Re-read with offset=N+1 (filePath=..., limit=200).
 *             Or use MCP nabiz_raw: sed -n 'N+1,Tp' <filePath>
 *      Marker çıktının SONUNA eklenir (başa eklenirse satır numarası
 *      formatı bozulur).
 *
 * Plugin tek sorumluluk: "dosyanın devamı var mı?" sorusuna cevap.
 * Prune/özetleme YAPMAZ. opencode-context-saver ile birlikte çalışır.
 *
 * Disable: plugin options'da `enabled: false`.
 * Bypass: tool çağrısında `#no-trunc-notice` substring.
 */

import { existsSync, readFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import { matchesSkipTools } from "nabiz-core/prune"
import {
  buildMarker,
  countLines,
  DISCLOSURE_SENTINEL,
  DISCLOSURE_TEXT,
  DEFAULT_SKIP_CONTAINS,
  parseLastLineNo,
  resolveFilePath,
} from "nabiz-core/truncation-notice"

interface TruncationNoticeConfig {
  enabled?: boolean
  /**
   * Hangi tool'lara marker eklenecek. Eşleşme suffix kuralıdır
   * (`matchesSkipTools`, `lib/prune.ts`): `read` girdisi `read` ve
   * `<herhangi-key>_read` adlarını yakalar — MCP key rename'lerine
   * bağışık. Kullanıcı listesi default'larla birleştirilir.
   */
  watchTools?: string[]
  lineSeparator?: string
  skipWhenContains?: string
}

const DEFAULT_CONFIG = {
  enabled: true,
  watchTools: ["read"],
  lineSeparator: "\t",
  skipWhenContains: DEFAULT_SKIP_CONTAINS,
}

function systemText(s: unknown): string {
  if (typeof s === "string") return s
  if (s != null && typeof s === "object" && "text" in (s as Record<string, unknown>)) {
    return String((s as Record<string, unknown>).text ?? "")
  }
  return ""
}

/** V2 hook event'i runtime'da mutable draft'tır; tipe `readonly` yazar. */
function setResultText(result: { content?: unknown }, text: string): void {
  ;(result as { content: unknown }).content = text
}

/** V2 `Tool.Result.content`: string | Content[] — düz metne indir. */
function resultToText(result: { content?: unknown }): string {
  const c = result.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (p != null && typeof p === "object" && "text" in (p as Record<string, unknown>)) {
          return String((p as Record<string, unknown>).text ?? "")
        }
        try {
          return JSON.stringify(p)
        } catch {
          return String(p)
        }
      })
      .join("\n")
  }
  if (c == null) return ""
  return String(c)
}

export default Plugin.define({
  id: "opencode-truncation-noticer",
  async setup(ctx) {
    const userConfig = ((ctx.options ?? {}) as TruncationNoticeConfig) as TruncationNoticeConfig
    const config = { ...DEFAULT_CONFIG, ...userConfig }
    // watchTools merge edilir (replace değil): kullanıcı kendi girdisini
    // eklediğinde default `read` koruması sessizce uçmaz. Dedupe'lu birleşim.
    if (userConfig.watchTools !== undefined) {
      config.watchTools = [...new Set([...DEFAULT_CONFIG.watchTools, ...userConfig.watchTools])]
    }

    // V1 `experimental.chat.system.transform` → V2 `session.hook("context")`.
    await ctx.session.hook("context", (event) => {
      if (!config.enabled) return
      if (event.system.some((s) => systemText(s).includes(DISCLOSURE_SENTINEL))) return
      event.system.push({ type: "text", text: DISCLOSURE_TEXT })
    })

    await ctx.tool.hook("execute.after", (event) => {
      if (!config.enabled) return
      if (event.status !== "completed") return
      if (!matchesSkipTools(event.tool, config.watchTools ?? [])) return

      const args = (event.input ?? {}) as Record<string, unknown>
      const skipMarker = config.skipWhenContains
      for (const v of Object.values(args)) {
        if (typeof v === "string" && v.includes(skipMarker)) return
      }

      const filePath = resolveFilePath(args.filePath ?? args.path)
      if (!filePath) return

      let totalLines = -1
      try {
        if (!existsSync(filePath)) return
        const content = readFileSync(filePath, "utf8")
        totalLines = countLines(content)
      } catch {
        return
      }
      if (totalLines <= 0) return

      const lastLineNo = parseLastLineNo(resultToText(event.result), config.lineSeparator)
      if (lastLineNo <= 0) return
      if (lastLineNo >= totalLines) return

      const nextOffset = lastLineNo + 1
      const marker = buildMarker(lastLineNo, totalLines, filePath, nextOffset)
      setResultText(event.result, resultToText(event.result) + marker)
    })
  },
})
