/**
 * Paylaşımlı tool-output trimleme ve özet helper'ları.
 *
 * Tasarım: deepseek-harness `compaction-tool-result-pruner` paketinin
 * head+marker+tail desenini temel alır. Deterministik, idempotent,
 * LLM çağrısı YAPMAZ — bu bilinçli bir tercih:
 *
 *   - Hedef kitle OpenCode'u free / küçük context'li (4K–32K) modellerle
 *     kullanıyor. Özet için ayrı bir LLM çağrısı, kırpmanın kazancını
 *     yiyen ek context maliyeti yaratır.
 *   - "Özetlenmiş model = kullanılan model" olduğunda küçük context'li
 *     hedef model zaten özet kalitesini kaldırmaz; bilgi kaybı telafi
 *     edilemez.
 *   - Free / yerel kullanımda ek API call = ek fatura + latency + key
 *     zorunluluğu; plugin'in sıfır maliyet avantajını bozar.
 *
 * Bu nedenle strateji: format-aware truncation + key-aware budama +
 * hata satırı önceliklendirme. LLM özeti ancak OpenCode gerçek bir
 * özet kancası sunarsa (örn. `experimental.hook.compacting`) eklenebilir.
 *
 * - `codePointLength`: Unicode code-point sayar (surrogate-safe, emoji yarılmaz).
 * - `pruneMiddle`: head+marker+tail ile ortayı budar; replacement < input garantisi.
 * - `extractSummarySafe`: per-key + toplam bütçe uygular; obje derinliğini sınırlar.
 * - `isBuildCommand`: shell operatörlerine göre segmentlere ayırır, her segmentin
 *   ilk token'ını veya ilk iki token phrase'ini kontrol eder.
 * - `extractErrors`: hata benzeri satırları yakalar, son N satır her zaman korunur.
 *
 * @module plugins/lib/prune
 */

export const PRUNE_MARKER = "\n\n[... tool output middle pruned ...]\n\n"

/**
 * LLM'e declare eden bilgilendirici marker.
 *
 * `pruneMiddle()` `text.length` ve `result.length`'i code-point olarak
 * biliyor; orijinal/kept oranını ve escape ipucunu marker'a gömerek
 * LLM'in "bu çıktı kırpıldı, ham lazımsa `no_prune=true` kullan ya da
 * eklentiyi `enabled:false` (off) ile kapat" demesini
 * sağlıyoruz. Format determinizm → idempotent ikinci pass aynı sonucu verir.
 */
export interface PruneMarkerStats {
  originalChars: number
  keptChars: number
  escapeHint?: string
}

export function formatPruneMarker(stats: PruneMarkerStats): string {
  const { originalChars, keptChars, escapeHint } = stats
  const saved = originalChars === 0
    ? 0
    : Math.round(((originalChars - keptChars) / originalChars) * 1000) / 10
  const hint = escapeHint ?? "no_prune=true (this call) or enabled:false (off)"
  return (
    `\n\n[... pruned: ${originalChars}→${keptChars} chars ` +
    `(${saved}% saved). For raw output: ${hint}. ...]\n\n`
  )
}

/**
 * Kısa marker: oturumdaki ilk kırpmadan sonrakiler için. Tam mekanizma
 * bilgisi tekrar tekrar yazılmaz; sadece karakter sayıları, kırpma
 * oranı ve **tüm 5 kaçış yolu** kalır.
 *
 * `opts.skipWhenContains` verilirse marker o değerle yazılır (config
 * `skipWhenContains` ile senkron). `opts.disableForCalls > 0` ve
 * `opts.alwaysRawCommands.length > 0` ise ilgili yollar da görünür.
 *
 * Marker LLM'in tek gördüğü bilgi kaynağıdır (system prompt
 * disclosure'ına güvenmek riskli — `experimental.chat.system.transform`
 * hook sözleşmesi OpenCode runtime'ında kesin değil). Bu yüzden 5 yol
 * burada deterministik olarak listelenir; format önceki haliyle
 * uyumsuzdur ama geriye uyumluluk gerektirmez (marker LLM'e bilgi
 * taşır, makine parse'ına konu olmaz).
 */
export function formatShortPruneMarker(
  stats: PruneMarkerStats,
  opts: {
    skipWhenContains?: string
    disableForCalls?: number
    alwaysRawCommands?: readonly string[]
  } = {},
): string {
  const { originalChars, keptChars } = stats
  const skip = opts.skipWhenContains ?? "#no-prune"
  const ways: string[] = [
    "no_prune/noPrune/skipPrune (per-call flag)",
    `embed "${skip}" in args`,
    "disableForCalls=N (next N raw)",
    "alwaysRawCommands (config whitelist)",
    "enabled:false (off)",
  ]
  return (
    `\n\n[... pruned: ${originalChars}→${keptChars} chars. ` +
    `Raw ways: ${ways.join(" | ")} ...]\n\n`
  )
}

/**
 * Eski (basit) marker — geriye uyumluluk için korunur.
 * Yeni kod `formatPruneMarker` kullansın.
 */

/** Unicode code-point sayısı (UTF-16 code unit değil). */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

export interface PruneMiddleOptions {
  headChars?: number
  tailChars?: number
  marker?: string
  /**
   * Dinamik marker üretici. Verilirse `marker` (string) yok sayılır;
   * budama gerçekleştiğinde `(stats: PruneMarkerStats) => string`
   * çağrılarak marker oluşturulur. Verilmezse `marker` veya default
   * `PRUNE_MARKER` kullanılır (geriye uyumlu).
   */
  markerBuilder?: (stats: PruneMarkerStats) => string
  /**
   * Pruning'i tamamen kapatır. `false` ise `text` aynen döner.
   * Plugin options'tan okunan global `enabled` toggle burada uygulanır;
   * kullanıcı debug iterasyonlarında tüm kırpmayı devre dışı bırakır.
   */
  enabled?: boolean
  /**
   * Bu substring'lerden biri `text` içinde geçerse prune atlanır.
   * Default `#no-prune`. Kullanıcı tool çağrısının gövdesine
   * `#no-prune` yazarak o çağrıya dokunulmamasını ister; LLM de
   * marker'da gördüğü `no_prune=true` ipucuyla bu yöntemi tercih eder.
   */
  skipWhenContains?: string
}


/**
 * Tool args içinde per-call bypass sinyali var mı?
 * - boolean flag: no_prune / noPrune / skipPrune / "no-prune"
 * - string değerlerde skipWhenContains substring
 */
export function shouldSkipForArgs(args: unknown, skipWhenContains = "#no-prune"): boolean {
  if (!args || typeof args !== "object") return false
  const obj = args as Record<string, unknown>
  if (
    obj.no_prune === true ||
    obj.noPrune === true ||
    obj.skipPrune === true ||
    (obj as Record<string, unknown>)["no-prune"] === true
  )
    return true
  if (typeof obj.no_prune === "string" && (obj.no_prune as string).toLowerCase() === "true") return true
  if (typeof obj.noPrune === "string" && (obj.noPrune as string).toLowerCase() === "true") return true
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && skipWhenContains && v.includes(skipWhenContains)) return true
  }
  return false
}

/**
 * Always-raw komut eşleşmesi: `args` içindeki string değerlerde desen ara.
 * - Düz desen: substring eşleşmesi.
 * - `regex:` önekli desen: RegExp testi (geçersiz desen throw — fail loud;
 *   config yüklenirken `resolveConfig` önden doğrular).
 */
export function matchesRawPatterns(args: unknown, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false
  const texts = collectStrings(args)
  if (texts.length === 0) return false
  return patterns.some((p) => {
    if (p.startsWith("regex:")) {
      const re = new RegExp(p.slice("regex:".length))
      return texts.some((t) => re.test(t))
    }
    return texts.some((t) => t.includes(p))
  })
}

/**
 * skipTools eşleşmesi: exact + `_<entry>` suffix.
 *
 * Neden suffix? opencode MCP tool adını `<server-key>_<tool>` olarak
 * expose eder; server key config'te kullanıcı tarafından seçilir ve
 * rename edilebilir (`opencode-mcp-bash-tools` → `bash`). Düz
 * `includes` listesi böyle bir rename'de sessizce bozulur (çift-kırpma
 * geri gelir). Suffix kuralı key'den bağımsızdır: `bash_safe` girdisi
 * hem `bash_safe` hem `opencode-mcp-bash-tools_bash_safe` hem de
 * gelecekteki herhangi bir `<key>_bash_safe` adını yakalar.
 *
 * Ayraç şartı (`"_" + entry`): `read` girdisinin `bread`/`thread` gibi
 * tool'ları yanlış yakalamasını önler — eşleşme ya tam ad ya da
 * alt-çizgi sınırında olur. Case-sensitive (mevcut `skipTools`
 * sözleşmesi korunur).
 */
export function matchesSkipTools(toolName: string, skipTools: readonly string[]): boolean {
  return skipTools.some((e) => e.length > 0 && (toolName === e || toolName.endsWith("_" + e)))
}

function collectStrings(value: unknown, depth = 0, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value]
  if (value === null || typeof value !== "object" || depth > 5 || seen.has(value)) return []
  seen.add(value)
  const out: string[] = []
  for (const v of Object.values(value)) out.push(...collectStrings(v, depth + 1, seen))
  return out
}

/**
 * Head + marker + tail. Replacement her zaman < input olmalı (idempotent
 * ikinci pass için zorunlu). Config bütçe aşılırsa throw eder — sessiz
 * büyüme yerine construct-time'da patlar.
 */
export function pruneMiddle(
  text: string,
  options: PruneMiddleOptions = {},
): string {
  // Kullanıcı veya plugin options pruneları kapatmışsa dokunma.
  if (options.enabled === false) return text
  // Inline escape marker — kullanıcı tool çağrısının içine yazdı.
  const skip = options.skipWhenContains ?? "#no-prune"
  if (skip && text.includes(skip)) return text

  const head = options.headChars ?? 100
  const tail = options.tailChars ?? 50
  const points = Array.from(text)
  const originalChars = points.length

  if (originalChars <= head + tail) return text

  const builder = options.markerBuilder
  const marker =
    builder?.({
      originalChars,
      keptChars: head + tail,
    }) ??
    options.marker ??
    PRUNE_MARKER
  const markerLen = codePointLength(marker)
  const budget = head + tail + markerLen

  if (head < 0 || tail < 0 || markerLen < 0) {
    throw new Error(
      `pruneMiddle: invalid budget (head=${head}, tail=${tail}, marker=${markerLen})`,
    )
  }

  const result =
    points.slice(0, head).join("") +
    marker +
    points.slice(originalChars - tail).join("")
  const resultLen = codePointLength(result)

  if (resultLen >= points.length || resultLen > budget) {
    throw new Error(
      `pruneMiddle: replacement (${resultLen} code points) must be < input (${points.length}) and within budget (${budget})`,
    )
  }
  return result
}

export interface ExtractSummaryOptions {
  maxCharsPerKey?: number
  maxSummaryChars?: number
  /** Stringify truncation koruması: büyük objeler için hızlı boyut tahmini. */
  maxObjectStringifyChars?: number
}

/**
 * `tool(k1=v1, k2=v2)` formatında özet. Her key değeri code-point cap'lenir,
 * toplam özet bütçesi aşılırsa erken kırılır. Obje/array değerler için
 * `maxObjectStringifyChars` koruması: tahmin aşılırsa `[Object: {n keys}]`
 * placeholder basar, JSON allocation maliyetinden kaçınır.
 */
export function extractSummarySafe(
  tool: string,
  args: Record<string, unknown> | null | undefined,
  options: ExtractSummaryOptions = {},
): string {
  const maxPerKey = options.maxCharsPerKey ?? 40
  const maxTotal = options.maxSummaryChars ?? 200
  const maxObj = options.maxObjectStringifyChars ?? 200

  const parts: string[] = [`${tool}(`]
  let used = codePointLength(parts[0])

  if (args && typeof args === "object") {
    for (const [k, v] of Object.entries(args)) {
      if (v == null) continue
      const piece = `${k}=${summarizeValue(v, maxPerKey, maxObj)}`
      const pieceLen = codePointLength(piece) + 2 // ", "
      if (used + pieceLen > maxTotal) {
        parts.push(`+${Object.keys(args).length - parts.length + 1} more`)
        break
      }
      parts.push(piece)
      used += pieceLen
    }
  }

  parts.push(")")
  return parts.join(", ")
}

function summarizeValue(v: unknown, maxChars: number, maxObj: number): string {
  if (typeof v === "string") return truncate(v, maxChars)
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]"
    return `[${v.length} items]`
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as object)
    if (keys.length === 0) return "{}"
    // Tahmin: bir obje > maxObj ise placeholder, allocation'dan kaçın
    const approx = keys.reduce((acc, k) => acc + k.length + 8, 2)
    if (approx > maxObj) return `{${keys.length} keys}`
    try {
      return truncate(JSON.stringify(v), maxChars)
    } catch {
      return "{…}"
    }
  }
  return truncate(String(v), maxChars)
}

function truncate(s: string, max: number): string {
  if (max <= 0) return ""
  const pts = Array.from(s)
  if (pts.length <= max) return s
  return pts.slice(0, max).join("") + "…"
}

/** Segment bazlı shell komut ayrıştırma. */
function splitShellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|(?![0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * First-token exact match + phrase match. Substring matching FP üretir
 * ("rain" → "training"), bu yüzden kelime sınırı şart.
 *
 * Phrase listesindeki iki-token kalıplar (`npm run`, `docker build`)
 * chained form için (`cd web && npm run build`) kritik — segment bazlı çalışır.
 */
const BUILD_TOKENS = new Set<string>([
  "build", "compile", "cargo", "npm", "pnpm", "yarn",
  "bun", "make", "cmake", "gradle", "mvn", "go", "tsc",
  "vite", "webpack", "esbuild", "rollup", "tailwind", "maven",
  "docker", "pip", "pip3", "forge", "rgsx", "rain",
  // Test-runner'lar (TASK-128): session açılmazsa after-hook erken döner ve
  // hata tespiti hiç çalışmaz. Çıplak `node`/`python` YOK — her script
  // session açardı (gürültü); `python -m` phrase olarak var.
  "pytest", "jest", "vitest",
])
const BUILD_PHRASES = new Set<string>([
  "npm run", "bun run", "yarn run", "pnpm run",
  "next build", "docker build",
  "pip install", "pip3 install",
  "python -m", "npx jest", "npx vitest",
])

export function isBuildCommand(command: string): boolean {

  for (const seg of splitShellSegments(command)) {
    const lower = seg.toLowerCase()
    const parts = lower.split(/\s+/)
    const first = parts[0] ?? ""
    if (BUILD_TOKENS.has(first)) return true
    if (parts.length >= 2 && BUILD_PHRASES.has(`${first} ${parts[1]}`)) return true
  }
  return false
}

export interface ExtractErrorsOptions {
  maxLines?: number
  /** Her zaman dahil edilecek son satır sayısı (en diagnostik genelde sonda). */
  tailLines?: number
}

const ERROR_LINE_RE =
  /\berror\b|\bfailed\b|^\s*→|^\s*error\[|TypeError|ReferenceError|SyntaxError|^Cannot find|^Unable to|^Unresolved|^npm ERR!|^fatal|^panic/i

/**
 * Hata benzeri satırları yakalar. `maxLines` cap'ine ek olarak `tailLines`
 * kadar son satır her zaman korunur — yığının sonu çoğu zaman kök neden.
 */
export function extractErrors(
  output: string,
  options: ExtractErrorsOptions = {},
): string[] {
  const max = options.maxLines ?? 15
  const tail = options.tailLines ?? 5
  const lines = output.split("\n")

  const matches = lines.filter((line) => ERROR_LINE_RE.test(line))
  if (matches.length === 0) return []
  const tailSet = new Set(lines.slice(-tail))
  // tail satırları her zaman ekle, head satırlarını max'e kadar doldur
  const head = matches.filter((l) => !tailSet.has(l)).slice(0, Math.max(0, max - tail))
  const tailKept = lines.slice(-tail)
  return [...head, ...tailKept].slice(0, max + tail)
}

/** `compressThreshold` ile head+tail+marker bütçesini doğrula. */
export function resolvePruneBudget(cfg: {
  compressThreshold: number
  headChars: number
  tailChars: number
  marker?: string
}): void {
  const marker = cfg.marker ?? PRUNE_MARKER
  const emitted = cfg.headChars + codePointLength(marker) + cfg.tailChars
  if (emitted > cfg.compressThreshold) {
    throw new Error(
      `prune budget invalid: headChars(${cfg.headChars}) + marker(${codePointLength(marker)}) + tailChars(${cfg.tailChars}) = ${emitted} > threshold(${cfg.compressThreshold})`,
    )
  }
}
