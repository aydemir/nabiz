import { Plugin } from "@opencode/plugin"
import { isBuildCommand } from "nabiz-core/prune"
import { BUILD_TRACKER_SENTINEL, BUILD_TRACKER_TEXT } from "nabiz-core/build-tracker-disclosure"

interface BuildConfig {
  thresholdMs: number
  /**
   * Ana şalter (default true). `false` ise hiçbir hook kaydolmaz —
   * bundle (`nabiz` paketi) tek kill-switch olarak `enabled:false`'ı
   * tüm alt pluginlere yayar.
   */
  enabled?: boolean
  /**
   * Sessiz mod (default false = sessiz). `true` ise `[Build Hook] ...`
   * satırları stdout'a yazılır; Termux/OpenTUI'da bu satırlar input'ta
   * hayalet yazı (ghost text) bırakıyordu. Kalıcı kayıt `ctx.storage`'da
   * (`nabiz:last-build`), debug akışı stdout'tadır.
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
  enabled: true,
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

function systemText(s: unknown): string {
  if (typeof s === "string") return s
  if (s != null && typeof s === "object" && "text" in (s as Record<string, unknown>)) {
    return String((s as Record<string, unknown>).text ?? "")
  }
  return ""
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
  if (typeof c === "object") {
    try {
      return JSON.stringify(c)
    } catch {
      return String(c)
    }
  }
  return String(c)
}

export default Plugin.define({
  id: "opencode-build-tracker",
  async setup(ctx) {
    const config: BuildConfig = { ...DEFAULT_CONFIG, ...((ctx.options ?? {}) as BuildConfig) }
    if (config.enabled === false) return
    // Additive: builtin'ler + kullanıcı desenleri. Replace yok — kullanıcı
    // deseni ekleyince rustc/npm/tsc kapsamı kaybolmaz.
    const errorPatterns: RegExp[] = [
      ...BUILD_ERROR_PATTERNS,
      ...compileExtraErrorPatterns(config.extraErrorPatterns ?? []),
    ]
    const sess = createSession()
    const pendingCalls = new Map<string, number>()

    const endSession = (status: "success" | "failed") => {
      const duration = Date.now() - sess.startTime
      const command = sess.command
      const dur = formatDuration(duration)
      // stdout'a yazma: Termux/OpenTUI'da hayalet yazı bırakıyor.
      // Sadece verbose:true ise yaz (debug). Kalıcı kayıt altta storage'da.
      if (config.verbose) {
        console.log(
          `[Build Hook] ${status === "success" ? "✅ onBuildSuccess" : "❌ onBuildFailure"}: ${command} — ${dur}`,
        )
      }
      // 1) Kalıcı kayıt (V2: ctx.storage — V1'deki client.app.log karşılığı.
      //    V2 App tipinde log yok; storage plugin-scoped durable JSON'dur.)
      // 2) TUI toast YOK (2026-09-04): toast metni istemcide sonraki
      //    prompt'un parts dizisine id'siz text parçası olarak sızıp oturumu
      //    kilitliyordu. Bildirim yalnızca kalıcı kayıtta.
      void ctx.storage
        .set("nabiz:last-build", {
          ts: new Date().toISOString(),
          service: "build-tracker",
          level: status === "failed" ? "error" : "info",
          message: `Build ${status}: ${command} (${dur})`,
          extra: { status, duration, command },
        })
        .catch(() => {})
      sess.active = false
      sess.command = ""
      sess.callIDs = []
      sess.startTime = 0
      sess.status = "idle"
      sess.buildCallID = null
    }

    // Mini-disclosure (TASK-129, ~45 token): LLM `extraErrorPatterns` +
    // kayıt satır anlamını oturum başında öğrenir. Sentinel-idempotent.
    // V1 `experimental.chat.system.transform` → V2 `session.hook("context")`.
    await ctx.session.hook("context", (event) => {
      if (event.system.some((s) => systemText(s).includes(BUILD_TRACKER_SENTINEL))) return
      event.system.push({ type: "text", text: BUILD_TRACKER_TEXT })
    })

    await ctx.tool.hook("execute.before", (event) => {
      const cmd = getCommandFromArgs(event.input)
      if (cmd && isBuildCommand(cmd)) {
        if (sess.active) endSession("failed")
        sess.active = true
        sess.command = cmd
        sess.startTime = Date.now()
        sess.status = "running"
        sess.buildCallID = event.id
        if (config.verbose) console.log(`[Build Hook] 🔨 onBuildStart: ${cmd}`)
      }
      if (sess.active) {
        pendingCalls.set(event.id, Date.now())
        sess.callIDs.push(event.id)
      }
    })

    await ctx.tool.hook("execute.after", (event) => {
      if (!sess.active) return
      if (event.status !== "completed") {
        pendingCalls.delete(event.id)
        return endSession("failed")
      }
      const startTime = pendingCalls.get(event.id) ?? Date.now()
      pendingCalls.delete(event.id)
      const duration = Date.now() - startTime

      const outStr = resultToText(event.result)
      // Build araçlarının bilinen hata formatları. Generic "error"/"failed"
      // kelime araması yorum satırı, help text gibi durumlarda false positive
      // üretiyor. Anchor'lar (^, satır başı) yorum/help'i filtreler, gerçek
      // build hata çıktısını yakalar.
      const hasError = errorPatterns.some((re) => re.test(outStr))
      const isBuildCall = sess.buildCallID === event.id

      // Surface'e (result.content) yazmıyoruz — context-saver kırpabilir,
      // sıra bağımlılığı ortadan kalkar. Bilgi storage'da log-only durur.

      if (hasError) {
        if (config.verbose) {
          console.log(
            `[Build Hook] ❌ onBuildFailure: ${event.tool} — errors detected in ${formatDuration(duration)}`,
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
    })

    // V1 `event` hook'u → V2 `ctx.event.subscribe()`: komut/build olaylarını
    // dinle. chat.message kancası yoktu; build bilgisi endSession içinde
    // yalnızca kalıcı kayda yazılıyor (toast kaldırıldı 2026-09-04).
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          const e = raw as unknown as Record<string, unknown>
          const type = e.type as string
          if (type === "command.executed" || type === "tui.command.execute") {
            const cmd =
              (e as { command?: unknown }).command ??
              (e as { data?: { command?: unknown } }).data?.command ??
              ""
            if (typeof cmd === "string" && isBuildCommand(cmd)) {
              if (!sess.active) {
                sess.active = true
                sess.command = cmd
                sess.startTime = Date.now()
                sess.status = "running"
                if (config.verbose) console.log(`[Build Hook] 🔨 onBuildStart (event): ${cmd}`)
              }
            }
            continue
          }
          if (type === "session.idle") {
            if (sess.active) {
              endSession("success")
            }
          }
        }
      } catch {
        // abort ile kapanır — sessiz.
      }
    })()

    return () => {
      controller.abort()
      pendingCalls.clear()
    }
  },
})
