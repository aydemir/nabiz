/**
 * opencode-nabiz-updater ("nu")
 *
 * Oturum başına bir kez registry'ye bakar, kurulu sürüm gerideyse tek
 * cümlelik bildirim verir. Upstream'in `ctrl+r` updater'ı nabız'ı göremez
 * (opencode `Npm.parse()` yalnızca registry/git spec kabul eder, yerel
 * `file:` tgz kurulumu envanterden düşer) — bu yüzden bildirim burada.
 *
 * Kanal seçimi: TUI toast DEĞİL. Toast 2026-09-04'te build-tracker'dan
 * kaldırıldı (metin istemcide sonraki turda kayboluyordu); yerine kalıcı
 * yol `session.hook("context")` disclosure'sı — diğer noticlerle aynı desen.
 *
 * Disable: plugin options'da `enabled: false` (kill-switch: hiçbir hook
 * kaydolmaz).
 */

import { readFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import {
  buildUpdateNotice,
  checkForUpdate,
  createRegistryFetcher,
  DEFAULT_PACKAGE,
  DEFAULT_REGISTRY,
  DEFAULT_TIMEOUT_MS,
  UPDATE_SENTINEL,
} from "nabiz-core/updater-notice"

interface UpdaterConfig {
  enabled?: boolean
  packageName?: string
  registry?: string
  timeoutMs?: number
}

const DEFAULT_CONFIG: UpdaterConfig = {
  enabled: true,
}

/**
 * Kurulu sürümü paket manifestinden okur. Okunamazsa `undefined` → kontrol
 * atlanır (sessiz). `import.meta.url`'den göreli yol: plugin `dist/` altında
 * çalıştığı için bir üst dizin paket köküdür.
 */
function installedVersion(): string | undefined {
  try {
    const manifest = new URL("../../package.json", import.meta.url)
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }
    if (typeof parsed.version !== "string" || parsed.version === "") return undefined
    return parsed.version
  } catch {
    return undefined
  }
}

/** `session.hook("context")` event.system parçalarını düz metne indirir. */
function systemText(s: unknown): string {
  if (typeof s === "string") return s
  if (s != null && typeof s === "object" && "text" in (s as Record<string, unknown>)) {
    return String((s as Record<string, unknown>).text ?? "")
  }
  return ""
}

export default Plugin.define({
  id: "opencode-nabiz-updater",
  async setup(ctx) {
    const config = { ...DEFAULT_CONFIG, ...((ctx.options ?? {}) as UpdaterConfig) }
    // Kill-switch: hook hiç kaydedilmez.
    if (!config.enabled) return

    const installed = installedVersion()
    if (!installed) return

    let checked = false
    // V1 `experimental.chat.system.transform` → V2 `session.hook("context")`.
    await ctx.session.hook("context", async (event) => {
      // Sentinel ile idempotent: oturumda tek kez gömülür.
      if (checked) return
      checked = true
      if (event.system.some((s) => systemText(s).includes(UPDATE_SENTINEL))) return

      const result = await checkForUpdate(
        installed,
        createRegistryFetcher(
          config.packageName ?? DEFAULT_PACKAGE,
          config.registry ?? DEFAULT_REGISTRY,
          config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ),
      )
      if (!result.outdated || !result.latest) return
      event.system.push({
        type: "text",
        text: buildUpdateNotice({
          installed: result.installed,
          latest: result.latest,
          ...(config.packageName ? { packageName: config.packageName } : {}),
        }),
      })
    })
  },
})
