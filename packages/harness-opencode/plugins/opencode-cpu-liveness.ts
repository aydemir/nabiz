/**
 * opencode-cpu-liveness ("cl")
 *
 * CPU liveness probe script paketini LLM'e deklare eder (disclosure-only).
 * Önceki disclosure'larla aynı pattern (TASK-107/111):
 * `session.hook("context")` ile oturum başına bir kez
 * system prompt'a `CPU_LIVENESS_TEXT` push'lar (sentinel ile idempotent).
 *
 * Bu plugin izleme/öldürme YAPMAZ — işin kendisi
 * `@opencode-plugins/cpu-liveness-probe` paketinde
 * (`scripts/cpu-liveness-probe/`: probe + tree-kill + agent).
 * Tek sorumluluk: uzun derlemede LLM'in agent çalıştırma yolunu bilmesi
 * (özellikle farklı projelerde AGENTS.md okunmaz). Paket `private:true`
 * olduğu için `npx` başka projede 404 verir — bu yüzden disclosure'daki
 * komut `resolveAgentPath()` ile çözülen MUTLAK `node <path>` yoludur
 * (npx formu sadece yayımlı/global kurulumda fallback).
 *
 * Disable: plugin options'da `enabled: false`.
 */

import { Plugin } from "@opencode/plugin"
import {
  buildCpuLivenessText,
  CPU_LIVENESS_SENTINEL,
  resolveAgentPath,
} from "nabiz-core/cpu-liveness-disclosure"

interface CpuLivenessConfig {
  enabled?: boolean
}

const DEFAULT_CONFIG: CpuLivenessConfig = {
  enabled: true,
}

function systemText(s: unknown): string {
  if (typeof s === "string") return s
  if (s != null && typeof s === "object" && "text" in (s as Record<string, unknown>)) {
    return String((s as Record<string, unknown>).text ?? "")
  }
  return ""
}

export default Plugin.define({
  id: "opencode-cpu-liveness",
  async setup(ctx) {
    const userConfig = ((ctx.options ?? {}) as CpuLivenessConfig) as CpuLivenessConfig
    const config = { ...DEFAULT_CONFIG, ...userConfig }
    const text = buildCpuLivenessText(resolveAgentPath(import.meta.url))

    // V1 `experimental.chat.system.transform` → V2 `session.hook("context")`.
    await ctx.session.hook("context", (event) => {
      if (!config.enabled) return
      if (event.system.some((s) => systemText(s).includes(CPU_LIVENESS_SENTINEL))) return
      event.system.push({ type: "text", text })
    })
  },
})
