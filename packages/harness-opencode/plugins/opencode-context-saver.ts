import { Plugin } from "@opencode/plugin"
import {
  codePointLength,
  extractErrors,
  extractSummarySafe,
  formatPruneMarker,
  formatShortPruneMarker,
  matchesRawPatterns,
  matchesSkipTools,
  pruneMiddle,
  resolvePruneBudget,
  shouldSkipForArgs,
} from "nabiz-core/prune"
import { DISCLOSURE_SENTINEL, DISCLOSURE_TEXT } from "nabiz-core/disclosure"
import { readRawRefill } from "nabiz-core/raw-refill"

interface ToolLogEntry {
  name: string
  args: Record<string, unknown>
  result: string
  duration: number
  timestamp: number
  error: boolean
}

interface CompactConfig {
  maxLogEntries: number
  compressThreshold: number
  headChars: number
  tailChars: number
  maxCharsPerKey: number
  maxSummaryChars: number
  errorMaxLines: number
  errorTailLines: number
  injectAsSummary: boolean
  /**
   * Plugin seviyesinde global açma/kapama. `false` ise prune hiç uygulanmaz;
   * debug iterasyonlarında veya "bu projede context-saver istemiyorum"
   * durumlarında kullanılır. Default true.
   */
  enabled?: boolean
  /**
   * Per-call bypass substring. Tool args içinde veya output text içinde
   * bu substring varsa prune atlanır. Default "#no-prune".
   * LLM marker'ı da bu değeri kullanır.
   */
  skipWhenContains?: string
  /**
   * Bu tool adlarında prune uygulanmaz — kod okuma araçları için
   * LLM'in full output görmesi gerekir. Case-sensitive.
   * Eşleşme suffix kuralıdır: girdi ya tam ad (`read`) ya da
   * `_<girdi>` ile biten ad (`<herhangi-key>_nabiz_safe`) olmalı —
   * MCP server key rename'lerine bağışık. Kullanıcı listesi
   * default'larla birleştirilir (üzerine yazmaz).
   * Default: read/read_file/Read/grep/Grep/glob/Glob/list_dir/ListDir/search/Search
   *   + nabiz_safe/nabiz_raw (MCP, TASK-110)
   */
  skipTools?: string[]
  /**
   * Oturum başında LLM'e bir kezlik kaçış notu enjekte et
   * (`session.hook("context")`). Default true.
   * `false` ise sadece kırpma marker'ları bilgi verir.
   */
  discloseOnce?: boolean
  /**
   * Shell komut whitelist'i: tool `args` string değerlerinde substring
   * (veya `regex:` önekli desen) eşleşirse prune atlanır. Tool adları için
   * ayrı liste yoktur — mevcut `skipTools` kullanılır (teklik ilkesi).
   */
  alwaysRawCommands?: string[]
  /**
   * Geçici kapatma: oturum başına ilk N prune-eligible çağrıyı ham bırak,
   * sonra otomatik eski davranışa dön. Per-call `disableForCalls` /
   * `disable_for_calls` arg'ı sayacı doldurur. Default 0 (kapalı).
   */
  disableForCalls?: number
}

const DEFAULT_CONFIG: CompactConfig = {
  maxLogEntries: 50,
  compressThreshold: 500,
  headChars: 100,
  tailChars: 50,
  maxCharsPerKey: 40,
  maxSummaryChars: 200,
  errorMaxLines: 15,
  errorTailLines: 5,
  injectAsSummary: true,
  enabled: true,
  discloseOnce: true,
  alwaysRawCommands: [],
  disableForCalls: 0,
  skipWhenContains: "#no-prune",
  skipTools: [
    "read", "read_file", "Read", "grep", "Grep", "glob", "Glob", "list_dir", "ListDir", "search", "Search",
    // MCP server tools (TASK-110): nabiz server kendi kırpma/ham kararını veriyor.
    // Plugin bu tool'lara dokunmamalı — aksi halde iki kırpma katmanı üst üste biner.
    // Eşleşme `matchesSkipTools` ile suffix kuralıdır (`lib/prune.ts`): `nabiz_safe`
    // girdisi `<herhangi-key>_nabiz_safe` adını yakalar, o yüzden server key
    // rename'leri listeyi bozmaz.
    // Eski uzun adlar ayrıca listelenmez — suffix kuralı onları zaten kapsar.
    "nabiz_safe",
    "nabiz_raw",
    // Legacy: V1 `bash` key dönemi adları (`bash_safe`/`bash_raw`,
    // `opencode-mcp-bash-tools_bash_*`). Suffix kuralı yeni girdilerle
    // yakalanmaz, o yüzden açık tutulur (zararsız, dokunulmaz).
    "bash_safe",
    "bash_raw",
  ],
}

function resolveConfig(raw: Partial<CompactConfig> = {}): CompactConfig {
  const cfg: CompactConfig = { ...DEFAULT_CONFIG, ...raw }
  // skipTools merge edilir (replace değil): kullanıcı kendi girdisini
  // eklediğinde default korumalar (read/grep/glob + MCP) sessizce uçmaz.
  // Dedupe'lu birleşim; sıra: default'lar önce.
  if (raw.skipTools !== undefined) {
    cfg.skipTools = [...new Set([...(DEFAULT_CONFIG.skipTools ?? []), ...raw.skipTools])]
  }
  // enabled=false ise prune uygulanmayacağı için budget kontrolü gereksiz.
  if (cfg.enabled !== false) {
    resolvePruneBudget({
      compressThreshold: cfg.compressThreshold,
      headChars: cfg.headChars,
      tailChars: cfg.tailChars,
    })
  }
  if (cfg.headChars < 0 || cfg.tailChars < 0) {
    throw new Error(`context-saver: headChars/tailChars must be >= 0`)
  }
  for (const p of cfg.alwaysRawCommands ?? []) {
    if (p.startsWith("regex:")) void new RegExp(p.slice("regex:".length))
  }
  if (!Number.isInteger(cfg.disableForCalls ?? 0) || (cfg.disableForCalls ?? 0) < 0) {
    throw new Error(`context-saver: disableForCalls must be an integer >= 0`)
  }
  if (cfg.maxCharsPerKey < 1 || cfg.maxSummaryChars < 10) {
    throw new Error(`context-saver: maxCharsPerKey>=1, maxSummaryChars>=10 required`)
  }
  return cfg
}

function serializeOutput(value: unknown): string {
  if (typeof value === "string") return value
  if (value == null) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** V2 hook event'i runtime'da mutable draft'tır; tipe `readonly` yazar. */
function setResultText(result: { content?: unknown }, text: string): void {
  ;(result as { content: unknown }).content = text
}

/** V2 `Tool.Result.content`: string | Content[] — hepsini düz metne indir. */
function resultToText(result: { content?: unknown }): string {
  const c = result.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (p != null && typeof p === "object" && "text" in (p as Record<string, unknown>)) {
          return String((p as Record<string, unknown>).text ?? "")
        }
        return serializeOutput(p)
      })
      .join("\n")
  }
  if (c == null) return ""
  return serializeOutput(c)
}

function systemText(s: unknown): string {
  if (typeof s === "string") return s
  if (s != null && typeof s === "object" && "text" in (s as Record<string, unknown>)) {
    return String((s as Record<string, unknown>).text ?? "")
  }
  return ""
}

export default Plugin.define({
  id: "opencode-context-saver",
  async setup(ctx) {
    const config = resolveConfig((ctx.options ?? {}) as Partial<CompactConfig>)
    const logs: ToolLogEntry[] = []
    const startTimes = new Map<string, number>()
    // Oturum başına marker seviyesi: ilk kırpmada uzun (tam mekanizma),
    // sonrakilerde kısa marker. `markerBuilder` sadece prune anında
    // çağrıldığı için set'e ekleme burada güvenlidir.
    const disclosedSessions = new Set<string>()
    // Geçici kapatma sayaçları: sessionID -> kalan ham çağrı sayısı.
    const rawCounters = new Map<string, number>()
    let turnCallCount = 0

    const addLog = (entry: ToolLogEntry) => {
      logs.push(entry)
      if (logs.length > config.maxLogEntries) logs.shift()
      turnCallCount++
    }

    // Bir kezlik keşif notu: kırpma hiç yaşanmasa da LLM mekanizmayı
    // oturum başında öğrenir. İçerik kontrollü idempotent — host her
    // request'te mevcut system dizisini verdiği için tekrar eklenmez.
    // V1 `experimental.chat.system.transform` → V2 `session.hook("context")`.
    // V2 system parçaları `{ type: "text", text }` objesidir.
    await ctx.session.hook("context", (event) => {
      if (config.discloseOnce === false) return
      if (event.system.some((s) => systemText(s).includes(DISCLOSURE_SENTINEL))) return
      event.system.push({ type: "text", text: DISCLOSURE_TEXT })
    })

    await ctx.tool.hook("execute.before", (event) => {
      startTimes.set(event.id, Date.now())
    })

    await ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return
      const args = (event.input ?? {}) as Record<string, unknown>
      const startTime = startTimes.get(event.id) ?? Date.now()
      const duration = Date.now() - startTime
      startTimes.delete(event.id)
      const perCallSkip = shouldSkipForArgs(args, config.skipWhenContains ?? "#no-prune")
      const rawOutput = resultToText(event.result)

      const errors = extractErrors(rawOutput, {
        maxLines: config.errorMaxLines,
        tailLines: config.errorTailLines,
      })
      const isError = errors.length > 0
      const summary = extractSummarySafe(event.tool, args, {
        maxCharsPerKey: config.maxCharsPerKey,
        maxSummaryChars: config.maxSummaryChars,
      })

      const skipByTool = matchesSkipTools(event.tool, config.skipTools ?? [])
      // Geçici kapatma sayacı (oturum başına): config ilk değeri verir,
      // per-call arg doldurur, her bypass bir harcar.
      const sid = event.sessionID ?? "unknown"
      const refill = readRawRefill(args)
      if (refill !== undefined) rawCounters.set(sid, refill)
      if (!rawCounters.has(sid) && (config.disableForCalls ?? 0) > 0) {
        rawCounters.set(sid, Math.floor(config.disableForCalls ?? 0))
      }
      let counterBypass = false
      const remaining = rawCounters.get(sid) ?? 0
      if (remaining > 0 && !perCallSkip) {
        counterBypass = true
        rawCounters.set(sid, remaining - 1)
      }
      const whitelistBypass = matchesRawPatterns(args, config.alwaysRawCommands ?? [])
      const rawBypass = perCallSkip || counterBypass || whitelistBypass
      const shouldPrune = !rawBypass && !skipByTool && !isError && codePointLength(rawOutput) > config.compressThreshold
      const trimmed = shouldPrune
        ? pruneMiddle(rawOutput, {
            headChars: config.headChars,
            tailChars: config.tailChars,
            markerBuilder: (stats) => {
              const shortOpts = {
                skipWhenContains: config.skipWhenContains ?? "#no-prune",
                disableForCalls: config.disableForCalls ?? 0,
                alwaysRawCommands: config.alwaysRawCommands ?? [],
              }
              if (disclosedSessions.has(sid)) return formatShortPruneMarker(stats, shortOpts)
              disclosedSessions.add(sid)
              const longHint =
                `no_prune/noPrune/skipPrune (this call) | ` +
                `embed "${shortOpts.skipWhenContains}" in args | ` +
                `disableForCalls=N (next N raw) | ` +
                `alwaysRawCommands (config whitelist) | ` +
                `enabled:false (off in plugin config)`
              return formatPruneMarker({ ...stats, escapeHint: longHint })
            },
            enabled: config.enabled,
            skipWhenContains: config.skipWhenContains,
          })
        : rawOutput

      let entryResult: string
      if (rawBypass) {
        entryResult = rawOutput
      } else if (isError) {
        entryResult = errors.join("\n")
      } else {
        entryResult = trimmed
      }

      const entry: ToolLogEntry = {
        name: event.tool,
        args,
        result: entryResult,
        duration,
        timestamp: Date.now(),
        error: isError,
      }

      addLog(entry)

      if (rawBypass) {
        setResultText(event.result, rawOutput)
      } else if (isError) {
        setResultText(event.result, `⚠️ ${summary}\n${errors.join("\n")}\n⏱️ ${duration}ms`)
      } else if (shouldPrune) {
        setResultText(event.result, `[${summary}]\n${trimmed}\n⏱️ ${duration}ms`)
      }
      // else: küçük output'a dokunma, ham kalsın.
    })

    // V1 `chat.message` → V2 `session.hook("prompt")`: prompt admission'da
    // turn sayacını sıfırla. Sessiz mod korunur — TUI'ya yazılmaz.
    await ctx.session.hook("prompt", () => {
      turnCallCount = 0
    })

    return () => {
      logs.length = 0
      turnCallCount = 0
      startTimes.clear()
      disclosedSessions.clear()
      rawCounters.clear()
    }
  },
})
