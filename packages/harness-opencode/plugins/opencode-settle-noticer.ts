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
 *   4. `experimental.chat.system.transform` ile disclosure push'lar
 *      (sentinel ile idempotent).
 *
 * Dürüst sınır: turn-arası WAKEUP YOK. Oturum kapalıyken biten build,
 * ajan bir dahaki temasta (araç sonucu/oturum) öğrenir. Bloklu bekleme
 * gateway'de ölür, BM_ON_SETTLE yerel shell'dir — ikisi de ajanı
 * uyandırmaz; bu plugin "bir daha temas kurduğunda kaçırmaz".
 *
 * Disable: opencode.jsonc'de `enabled: false` (config).
 * Bypass: tool çağrısında `#no-settle-notice` substring.
 *
 * ⚠️ opencode 1.18.29 uyumluluğu: bu dosya sadece `default` export
 * yapıyor. Diğer sabitler `plugins/lib/settle-notice.ts`'de
 * (opencode'un `getLegacyPlugins` Object.values(mod) iterate ettiği
 * için Plugin olmayan export'lar "Plugin export is not a function"
 * hatası veriyor — bkz TASK-111).
 */

import { dirname } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
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

const SettleNoticePlugin: Plugin = async (_input, _options) => {
  // Config iki kaynaktan gelebilir: factory ikinci argümanı (options,
  // `pluginOptions` — Plugin tipindeki gerçek sözleşme) veya input.config
  // (mevcut pluginlerin kullandığı cast pattern'i). İkisini birleştir.
  const fromInput =
    ((_input as unknown as { config?: SettleNoticeConfig }).config ?? {}) as SettleNoticeConfig
  const fromOptions = ((_options ?? {}) as SettleNoticeConfig) as SettleNoticeConfig
  const config = { ...DEFAULT_CONFIG, ...fromInput, ...fromOptions }
  const staleAfterMs =
    typeof config.staleAfterMs === "number" &&
    Number.isFinite(config.staleAfterMs) &&
    config.staleAfterMs >= 0
      ? config.staleAfterMs
      : DEFAULT_STALE_AFTER_MS
  const cwd =
    typeof (_input as unknown as { directory?: unknown }).directory === "string"
      ? ((_input as unknown as { directory?: string }).directory as string)
      : process.cwd()

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      if (!config.enabled) return
      if (output.system.some((s) => s.includes(DISCLOSURE_SENTINEL))) return
      // Dinamik ek: oturum açılışında bekleyen settlelari disclosure'a göm
      // (snapshot, salt okunur — tool-output sunum katmanını baypas eder;
      // bildirim + işaretleme after-hook'un işi, bkz TASK-123 deneyi).
      const pending = scanSettled(
        resolveEventDirs(config.eventDirs, process.env, cwd),
        config.maxFiles,
      )
      output.system.push(DISCLOSURE_TEXT + buildPendingSuffix(pending))
    },

    "tool.execute.after": async (t, output) => {
      if (!config.enabled) return

      const args = (t.args ?? {}) as Record<string, unknown>
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
      output.output = (output.output ?? "") + suffix
    },
  }
}

export default SettleNoticePlugin
