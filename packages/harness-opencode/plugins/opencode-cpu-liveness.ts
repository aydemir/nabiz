/**
 * opencode-cpu-liveness ("cl")
 *
 * CPU liveness probe script paketini LLM'e deklare eder (disclosure-only).
 * Önceki disclosure'larla aynı pattern (TASK-107/111):
 * `experimental.chat.system.transform` hook'unda oturum başına bir kez
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
 * Disable: opencode.jsonc'de `pluginOptions["opencode-cpu-liveness"].enabled: false`
 * (server entry üzerinden gelirse `pluginOptions["opencode-plugins"].enabled: false`
 * dördünü birden kapatır — tek kill-switch).
 *
 * ⚠️ opencode 1.18.29 uyumluluğu: bu dosya sadece `default` export
 * yapar. Sabitler `plugins/lib/cpu-liveness-disclosure.ts`'de
 * (opencode'un `getLegacyPlugins` Object.values(mod) iterate ettiği
 * için Plugin olmayan export'lar "Plugin export is not a function"
 * hatası veriyor).
 */

import type { Plugin } from "@opencode-ai/plugin"
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

const CpuLivenessPlugin: Plugin = async (_ctx) => {
  const userConfig =
    ((_ctx as { config?: CpuLivenessConfig }).config ?? {}) as CpuLivenessConfig
  const config = { ...DEFAULT_CONFIG, ...userConfig }
  const text = buildCpuLivenessText(resolveAgentPath(import.meta.url))

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      if (!config.enabled) return
      if (output.system.some((s) => s.includes(CPU_LIVENESS_SENTINEL))) return
      output.system.push(text)
    },
  }
}

export default CpuLivenessPlugin
