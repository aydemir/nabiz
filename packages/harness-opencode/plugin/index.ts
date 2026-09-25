/**
 * nabiz — tek entrypoint V2 plugin paketi.
 *
 * V2 gerçeği: `plugins` config girdisi DİZİN kabul eder, dosya etmez; bir
 * dizinden SADECE `index.ts` yüklenir. Bu dosya altı plugin kurulumunu tek
 * `nabiz` id'si altında toplar — hook kayıt SIRASI discovery sırasıyla aynı
 * tutulur (alfabetik dosya sırası), böylece davranış değişmez:
 * context-saver kırpması, settle/truncation marker'larından ÖNCE koşar.
 *
 * Seçenekler: paket girdisinin `options` çantası paylaşılır; her alt plugin
 * kendi anahtarlarını okur (kendi default'larıyla). Per-plugin ayar için
 * plugin id'si altında alt-çanta verilir:
 * `{ "package": "<dir>", "options": { "opencode-truncation-noticer": { "enabled": false } } }`
 * Alt-çanta, paylaşılan anahtarların ÜSTÜNE yazılır. `enabled:false` (çanta
 * kökünde) TEK kill-switch'tir — hiçbir hook/tool kaydolmaz.
 *
 * Yükleme: config `plugins` girdisine bu dizin yazılır
 * (`setup.mjs --yes` otomatik yapar) veya
 * `opencode plugin add <git|npm>` ile paket kurulur.
 */

import { Plugin } from "@opencode/plugin"
import buildTracker from "../plugins/opencode-build-tracker.js"
import contextSaver from "../plugins/opencode-context-saver.js"
import cpuLiveness from "../plugins/opencode-cpu-liveness.js"
import hbmon from "../plugins/opencode-hbmon.js"
import settleNoticer from "../plugins/opencode-settle-noticer.js"
import truncationNoticer from "../plugins/opencode-truncation-noticer.js"

// Discovery sırasıyla aynı (alfabetik): prune → noticer'lar.
const SUB_PLUGINS = [
  buildTracker,
  contextSaver,
  cpuLiveness,
  hbmon,
  settleNoticer,
  truncationNoticer,
] as const

const NS_KEYS = new Set(SUB_PLUGINS.map((s) => s.id))

/**
 * İsim-alanlı seçenek çözümleme: paylaşılan çanta + `<plugin-id>` alt-çantası
 * (alt-çanta üstüne yazar). İsim-alanı anahtarları alt plugine sızmaz.
 */
function scopedOptions(
  shared: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const base = Object.fromEntries(Object.entries(shared).filter(([k]) => !NS_KEYS.has(k)))
  const sub = shared[id]
  if (sub !== null && typeof sub === "object" && !Array.isArray(sub)) {
    return { ...base, ...(sub as Record<string, unknown>) }
  }
  return base
}

export default Plugin.define({
  id: "nabiz",
  async setup(ctx) {
    const shared = ((ctx.options ?? {}) as Record<string, unknown>) as Record<string, unknown>
    if (shared.enabled === false) return
    const cleanups: Array<() => unknown> = []
    for (const sub of SUB_PLUGINS) {
      const cleanup = await sub.setup({ ...ctx, options: scopedOptions(shared, sub.id) })
      if (typeof cleanup === "function") cleanups.push(cleanup as () => unknown)
    }
    return () => {
      for (const cleanup of cleanups.reverse()) {
        try {
          const r = cleanup()
          if (r !== undefined && typeof (r as Promise<unknown>)?.then === "function") {
            void (r as Promise<unknown>).catch(() => {})
          }
        } catch { /* kapanışta sessiz */ }
      }
    }
  },
})
