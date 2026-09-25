/**
 * opencode-settle-noticer ("sn")
 *
 * build-mon ile izlenen derleme bitince (settle) sonucu SORULMADAN
 * modelin önüne düşürür — next-contact notice (TASK-123).
 *
 * Davranış:
 *   1. `tool.execute.after` hook'unda her araç sonucundan sonra event
 *      dizinlerindeki (`*.status.json`) finalleri tara.
 *   2. Final = `exit` alanı olan status (tüm build-mon finalleri exit
 *      yazar; HEARTBEAT/STALLED-uyarı/STARTED yazmaz).
 *   3. Bildirilmemiş final varsa çıktının SONUNA tek satırlık not ekle:
 *        [sn] settled: <name> <EVENT> (exit=<code>) — <detail> [<statusPath>]
 *      ve `<name>.notified` işaretle (bir final bir kez bildirilir;
 *      aynı adla YENİ final gelirse ts/event farklı → tekrar bildirilir).
 *   4. `session.hook("context")` ile disclosure push'lar
 *      (sentinel ile idempotent).
 *
 * Dürüst sınır: turn-arası WAKEUP YOK. Oturum kapalıyken biten build,
 * ajan bir dahaki temasta (araç sonucu/oturum) öğrenir. Bloklu bekleme
 * gateway'de ölür, BM_ON_SETTLE yerel shell'dir — ikisi de ajanı
 * uyandırmaz; bu plugin "bir daha temas kurduğunda kaçırmaz".
 * Gerçek uyandırma için hbmon `bg_run` kullan (bekçi aynı oturumda
 * `opencode run -s` ile yeni turn açar).
 *
 * Disable: plugin options'da `enabled: false`.
 * Bypass: tool çağrısında `#no-settle-notice` substring.
 */

import { dirname } from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  buildNotice,
  buildPendingSuffix,
  buildStaleNotice,
  DISCLOSURE_SENTINEL,
  DISCLOSURE_TEXT,
  DEFAULT_MAX_FILES,
  DEFAULT_SKIP_CONTAINS,
  DEFAULT_STALE_AFTER_MS,
  markNotified,
  markStaleNotified,
  resolveEventDirs,
  scanSettled,
  scanStale,
} from "nabiz-core/settle-notice"

interface SettleNoticeConfig {
  enabled?: boolean
  eventDirs?: string[]
  maxFiles?: number
  skipWhenContains?: string
  /**
   * Bayatlık eşiği (ms). Son olay final-dışı ve yaşı bunu aşarsa
   * `[sn] stale:` bildirilir (default 180000 = 3 × heartbeat).
   * Geçersiz değerde default'a düşülür (fail-soft; bu pluginde
   * construct-time throw presedenti yok).
   */
  staleAfterMs?: number
}

const DEFAULT_CONFIG = {
  enabled: true,
  eventDirs: undefined as string[] | undefined,
  maxFiles: DEFAULT_MAX_FILES,
  skipWhenContains: DEFAULT_SKIP_CONTAINS,
  staleAfterMs: DEFAULT_STALE_AFTER_MS,
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
  id: "opencode-settle-noticer",
  async setup(ctx) {
    // V1'de config iki kaynaktan geliyordu (factory options + input.config);
    // V2'de tek kaynak var: ctx.options.
    const config = { ...DEFAULT_CONFIG, ...((ctx.options ?? {}) as SettleNoticeConfig) }
    const staleAfterMs =
      typeof config.staleAfterMs === "number" &&
      Number.isFinite(config.staleAfterMs) &&
      config.staleAfterMs >= 0
        ? config.staleAfterMs
        : DEFAULT_STALE_AFTER_MS
    const cwd =
      typeof ctx.location?.directory === "string" && ctx.location.directory !== ""
        ? ctx.location.directory
        : process.cwd()

    // V1 `experimental.chat.system.transform` → V2 `session.hook("context")`.
    await ctx.session.hook("context", (event) => {
      if (!config.enabled) return
      if (event.system.some((s) => systemText(s).includes(DISCLOSURE_SENTINEL))) return
      // Dinamik ek: oturum açılışında bekleyen settlelari disclosure'a göm
      // (snapshot, salt okunur — tool-output sunum katmanını baypas eder;
      // bildirim + işaretleme after-hook'un işi, bkz TASK-123 deneyi).
      const pending = scanSettled(
        resolveEventDirs(config.eventDirs, process.env, cwd),
        config.maxFiles,
      )
      event.system.push({ type: "text", text: DISCLOSURE_TEXT + buildPendingSuffix(pending) })
    })

    await ctx.tool.hook("execute.after", (event) => {
      if (!config.enabled) return
      if (event.status !== "completed") return

      const args = (event.input ?? {}) as Record<string, unknown>
      const skipMarker = config.skipWhenContains
      for (const v of Object.values(args)) {
        if (typeof v === "string" && v.includes(skipMarker)) return
      }

      const dirs = resolveEventDirs(config.eventDirs, process.env, cwd)
      if (dirs.length === 0) return

      const settled = scanSettled(dirs, config.maxFiles)
      // Bayatlık (TASK-131): finalsız + yaşlı heartbeat → monitör-ölümü
      // şüphesi. Settle yolundan bağımsız dal; ikisi de boşsa dokunma.
      const stale = scanStale(dirs, staleAfterMs, config.maxFiles)
      if (settled.length === 0 && stale.length === 0) return

      let suffix = ""
      if (settled.length > 0) {
        suffix += buildNotice(settled)
        for (const rec of settled) {
          markNotified(dirname(rec.statusPath), rec)
        }
      }
      if (stale.length > 0) {
        suffix += buildStaleNotice(stale)
        for (const rec of stale) {
          markStaleNotified(dirname(rec.statusPath), rec)
        }
      }
      setResultText(event.result, resultToText(event.result) + suffix)
    })
  },
})
