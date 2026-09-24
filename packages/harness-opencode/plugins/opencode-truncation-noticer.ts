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
 *   2. `args.filePath` + toplam satır sayısı (fs.readFileSync ile)
 *      karşılaştır: son satır no toplamdan küçükse → marker ekle.
 *   3. Marker formatı:
 *        [tn] truncated: X more lines after line N (of T total).
 *             Re-read with offset=N+1 (filePath=..., limit=200).
 *             Or use MCP bash_raw: sed -n 'N+1,Tp' <filePath>
 *      Marker çıktının SONUNA eklenir (başa eklenirse satır numarası
 *      formatı bozulur).
 *
 * Plugin tek sorumluluk: "dosyanın devamı var mı?" sorusuna cevap.
 * Prune/özetleme YAPMAZ. opencode-context-saver ile birlikte çalışır.
 *
 * Disable: opencode.jsonc'de `enabled: false` (config).
 * Bypass: tool çağrısında `#no-trunc-notice` substring.
 *
 * ⚠️ opencode 1.18.29 uyumluluğu: bu dosya sadece `default` export
 * yapıyor. Diğer sabitler `plugins/lib/truncation-notice.ts`'de
 * (opencode'un `getLegacyPlugins` Object.values(mod) iterate ettiği
 * için Plugin olmayan export'lar "Plugin export is not a function"
 * hatası veriyor — bkz TASK-111).
 */

import { existsSync, readFileSync } from "node:fs"
import type { Plugin } from "@opencode-ai/plugin"
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

const TruncationNoticePlugin: Plugin = async (_ctx) => {
  const userConfig =
    ((_ctx as { config?: TruncationNoticeConfig }).config ?? {}) as TruncationNoticeConfig
  const config = { ...DEFAULT_CONFIG, ...userConfig }
  // watchTools merge edilir (replace değil): kullanıcı kendi girdisini
  // eklediğinde default `read` koruması sessizce uçmaz. Dedupe'lu birleşim.
  if (userConfig.watchTools !== undefined) {
    config.watchTools = [...new Set([...DEFAULT_CONFIG.watchTools, ...userConfig.watchTools])]
  }

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      if (!config.enabled) return
      if (output.system.some((s) => s.includes(DISCLOSURE_SENTINEL))) return
      output.system.push(DISCLOSURE_TEXT)
    },

    "tool.execute.after": async (t, output) => {
      if (!config.enabled) return
      if (!matchesSkipTools(t.tool, config.watchTools ?? [])) return

      const args = (t.args ?? {}) as Record<string, unknown>
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

      const lastLineNo = parseLastLineNo(output.output ?? "", config.lineSeparator)
      if (lastLineNo <= 0) return
      if (lastLineNo >= totalLines) return

      const nextOffset = lastLineNo + 1
      const marker = buildMarker(lastLineNo, totalLines, filePath, nextOffset)
      output.output = (output.output ?? "") + marker
    },
  }
}

export default TruncationNoticePlugin