import type { Plugin } from "@opencode-ai/plugin"
import { isBuildCommand } from "nabiz-core/prune"
import { BUILD_TRACKER_SENTINEL, BUILD_TRACKER_TEXT } from "nabiz-core/build-tracker-disclosure"

interface BuildConfig {
  thresholdMs: number
  /**
   * Sessiz mod (default false = sessiz). `true` ise `[Build Hook] ...`
   * satırları stdout'a yazılır; Termux/OpenTUI'da bu satırlar input'ta
   * hayalet yazı (ghost text) bırakıyordu. Kalıcı bildirim zaten
   * `client.app.log` ile veriliyor, stdout log'u gereksiz.
   */
  verbose?: boolean
  /**
   * Builtin `BUILD_ERROR_PATTERNS` listesine EK desenler (additive —
   * default'lar korunur, üzerine yazılmaz; birikimli-listelerde merge,
   * tam-listelerde replace kuralı).
   * String regex gövdesi olarak `m` flag'iyle derlenir (`^` satır
   * başlarında çalışır). Örn. pytest için `"^FAILED\\s"`, cargo-test
   * alt satırları için `"^test .* FAILED$"`.
   * Satır-başı anchor kullanın — ankorsuz genel kelimeler (örn. `error`)
   * yorum/help-text'ten false positive üretir (builtin'lardaki `^`
   * anchor'lar bu yüzden var). Geçersiz desen init'te throw eder
   * (fail-loud; `alwaysRawCommands` `regex:` presedenti).
   */
  extraErrorPatterns?: string[]
}

interface BuildSession {
  active: boolean
  command: string
  callIDs: string[]
  startTime: number
  status: "idle" | "running" | "success" | "failed"
  buildCallID: string | null
}

const DEFAULT_CONFIG: BuildConfig = {
  thresholdMs: 120000,
  verbose: false,
  extraErrorPatterns: [],
}

const BUILD_ERROR_PATTERNS = [
  /^error\[/m,           // rustc: error[E0425]
  /^npm ERR!/m,          // npm: npm ERR!
  /^\s*error TS\d+/m,    // tsc: error TS2304
  /^\s*→/m,              // biome, rust diagnostic
  /^FAILED:/m,           // bazel, buck
  /^FAIL\b/m,            // generic FAIL
  /^make.*\*\*\* /m,     // make: *** Error
  /^\s*error:/m,         // generic "error:" prefix (cargo, biome)
  /^error\b/m,           // yarn berry, pnpm (satır başı "error")
] as const

function getCommandFromArgs(args: unknown): string {
  if (!args || typeof args !== "object") return ""
  const a = args as Record<string, unknown>
  if (typeof a.command === "string") return a.command
  // hbmon_watch gibi argv-dizili araçlar: string[] → join (segmenter
  // zaten shell operatörlerine bölüyor, TASK-128).
  if (Array.isArray(a.command)) {
    const parts = a.command.filter((p): p is string => typeof p === "string")
    if (parts.length > 0) return parts.join(" ")
  }
  if (typeof a.cmd === "string") return a.cmd
  if (typeof a.input === "string") return a.input
  return ""
}

function createSession(): BuildSession {
  return { active: false, command: "", callIDs: [], startTime: 0, status: "idle", buildCallID: null }
}

/**
 * Kullanıcı desenlerini derle. `m` flag sabit — `^`/`$` satır
 * sınırlarında çalışmalı (builtin'larla aynı semantik). Geçersiz desen
 * construct-time'da throw eder; sessizce yutmak yanlış-✅ demektir.
 */
function compileExtraErrorPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => {
    try {
      return new RegExp(p, "m")
    } catch {
      throw new Error(`build-tracker: invalid extraErrorPatterns entry: ${JSON.stringify(p)}`)
    }
  })
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

interface ToolAfterOutput {
  output?: string
  metadata?: Record<string, unknown>
}

const BuildHooksPlugin: Plugin = async (input, options?: Record<string, unknown>) => {
  const config: BuildConfig = { ...DEFAULT_CONFIG, ...(options ?? {}) }
  // Additive: builtin'ler + kullanıcı desenleri. Replace yok — kullanıcı
  // deseni ekleyince rustc/npm/tsc kapsamı kaybolmaz.
  const errorPatterns: RegExp[] = [
    ...BUILD_ERROR_PATTERNS,
    ...compileExtraErrorPatterns(config.extraErrorPatterns ?? []),
  ]
  const sess = createSession()
  const pendingCalls = new Map<string, number>()
  const client = (input as unknown as { client?: { app?: { log?: (b: unknown) => Promise<void> | void } } }).client

  const endSession = (status: "success" | "failed") => {
    const duration = Date.now() - sess.startTime
    const command = sess.command
    const dur = formatDuration(duration)
    // stdout'a yazma: Termux/OpenTUI'da hayalet yazı bırakıyor.
    // Sadece verbose:true ise yaz (debug). Kalıcı log altta app.log'da.
    if (config.verbose) {
      console.log(
        `[Build Hook] ${status === "success" ? "✅ onBuildSuccess" : "❌ onBuildFailure"}: ${command} — ${dur}`,
      )
    }
    // 1) Kalıcı log (debug/replay)
    if (client?.app?.log) {
      void client.app.log({
        body: {
          service: "build-tracker",
          level: status === "failed" ? "error" : "info",
          message: `Build ${status}: ${command} (${dur})`,
          extra: { status, duration, command },
        },
      })
    }
    // 2) TUI toast KALDIRILDI (2026-09-04): toast metni istemcide sonraki
    //    prompt'un parts dizisine id'siz text parçası olarak sızıp oturumu
    //    kilitliyordu ("invalid user part before save" /
    //    EventV2.InvalidDurableEvent). Bildirim yalnızca kalıcı app log'da.
    sess.active = false
    sess.command = ""
    sess.callIDs = []
    sess.startTime = 0
    sess.status = "idle"
    sess.buildCallID = null
  }

  return {
    async dispose() {
      pendingCalls.clear()
    },

    // Mini-disclosure (TASK-129, ~45 token): LLM `extraErrorPatterns` +
    // `app.log` satır anlamını oturum başında öğrenir. Sentinel-idempotent.
    "experimental.chat.system.transform": async (_input, output) => {
      if (output.system.some((s) => s.includes(BUILD_TRACKER_SENTINEL))) return
      output.system.push(BUILD_TRACKER_TEXT)
    },

    "tool.execute.before": async (t, output) => {
      const args = (output as { args?: unknown })?.args ?? (t as { args?: unknown }).args ?? {}
      const cmd = getCommandFromArgs(args)
      if (cmd && isBuildCommand(cmd)) {
        if (sess.active) endSession("failed")
        sess.active = true
        sess.command = cmd
        sess.startTime = Date.now()
        sess.status = "running"
        sess.buildCallID = t.callID
        if (config.verbose) console.log(`[Build Hook] 🔨 onBuildStart: ${cmd}`)
      }
      if (sess.active) {
        pendingCalls.set(t.callID, Date.now())
        sess.callIDs.push(t.callID)
      }
    },

    "tool.execute.after": async (t, output) => {
      if (!sess.active) return
      const startTime = pendingCalls.get(t.callID) ?? Date.now()
      pendingCalls.delete(t.callID)
      const duration = Date.now() - startTime

      const outStr = (output as ToolAfterOutput).output ?? ""
      // Build araçlarının bilinen hata formatları. Generic "error"/"failed"
      // kelime araması yorum satırı, help text gibi durumlarda false positive
      // üretiyor. Anchor'lar (^, satır başı) yorum/help'i filtreler, gerçek
      // build hata çıktısını yakalar.
      const hasError = errorPatterns.some((re) => re.test(outStr))
      const isBuildCall = sess.buildCallID === t.callID

      // Surface'e (output.output) yazmıyoruz — context-saver kırpabilir,
      // sıra bağımlılığı ortadan kalkar. Bilgi metadata'da log-only durur.


      if (hasError) {
        if (config.verbose) {
          console.log(
            `[Build Hook] ❌ onBuildFailure: ${t.tool} — errors detected in ${formatDuration(duration)}`,
          )
        }
        return endSession("failed")
      }

      const checkThreshold = (dur: number) => {
        if (dur >= config.thresholdMs) {
          if (config.verbose) {
            console.log(
              `[Build Hook] ⏱️  onThresholdExceeded: ${formatDuration(dur)} (threshold: ${formatDuration(config.thresholdMs)})`,
            )
          }
        }
      }

      if (isBuildCall) {
        checkThreshold(Date.now() - sess.startTime)
        return endSession("success")
      }

      checkThreshold(Date.now() - sess.startTime)
    },

    // chat.message kancası: Build bilgisi endSession içinde yalnızca
// client.app.log (kalıcı) ile bildiriliyor. showToast 2026-09-04'te
// kaldırıldı (toast metni sonraki prompt'a sızıp oturumu kilitliyordu).
// 2026-09-04: console.log stdout da sessize alındı (verbose:false default);
// Termux/OpenTUI'da "[Build Hook]" satırları input'ta hayalet yazı bırakıyordu.
// output.metadata TUI'da render edilmediği için terk edildi
// (ağaç araştırması 2026-09-01).

    event: async ({ event }) => {
      const e = event as Record<string, unknown>
      const type = e.type as string

      if (type === "command.executed" || type === "tui.command.execute") {
        const cmd = (e as { command?: unknown }).command ?? (e as { data?: { command?: unknown } }).data?.command ?? ""
        if (typeof cmd === "string" && isBuildCommand(cmd)) {
          if (!sess.active) {
            sess.active = true
            sess.command = cmd
            sess.startTime = Date.now()
            sess.status = "running"
            if (config.verbose) console.log(`[Build Hook] 🔨 onBuildStart (event): ${cmd}`)
          }
        }
        return
      }

      if (type === "session.idle") {
        if (sess.active) {
          return endSession("success")
        }
        return
      }
    },
  }
}

export default BuildHooksPlugin
