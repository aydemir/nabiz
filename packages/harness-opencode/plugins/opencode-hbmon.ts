/**
 * opencode-hbmon — hbmon custom tool'ları (TASK-126).
 *
 * Ajan wakeup: `hbmon_watch` ile arka plana at, `hbmon_wait` ile tek
 * bloklayan çağrıda uyan (polling yok, context'e log sızmaz).
 * settle-noticer next-contact kalır; bu plugin turn-içi beklemeyi kapatır.
 *
 * bg_* (TASK-132): pi/nabız `bg_run` modelinin opencode karşılığı —
 * `bg_run` hemen döner, LLM serbest kalır; iş bitince bekçi script
 * (`scripts/bg-wake.mjs`, detached) `opencode run -s <session>` ile AYNI
 * oturumda yeni turn açar (canlı kanıt: /tmp/opencode-wake-test).
 * Uyandırma başına bir LLM turn'ü maliyeti vardır; `notify:false` kapatır.
 *
 * Dürüst sınır: bloklayan çağrı gateway tavanına (~60sn) takılırsa sonuç
 * değil kesinti döner — wait default 50sn, ajan tekrar çağırır.
 * Açık TUI ile eşzamanlı yazışma test edilmedi (headless kanıtlı).
 *
 * V2 notu: V1 `tool()` helper + dönen `tool` map'i → V2
 * `ctx.tool.transform(editor => editor.add(...))`. Şemalar JSON Schema,
 * execute `{ content }` döndürür. Tool adları aynı tutulur (LLM + test
 * uyumluluğu); namespace "build_pulse" (Faz 8; boşluk reddedilir —
 * NABIZ-011, host kuralı ^[A-Za-z0-9_-]{1,128}$).
 *
 * Faz 8: ToolContext (sessionID, agent, messageID, id, signal, progress)
 * tüm 7 tool'a bağlandı. signal → hbmon_wait/hbmon_status iptal;
 * progress → hbmon_wait ara-durum bildirimi. namespace "build_pulse".
 *
 * Disiplin: bm (`opencode-bm`) MCP'i söküldüğü için `DISCIPLINE_TEXT`'in
 * opencode karşılığı yanıtlara konur (BG_* sabitleri) — pi tarafındaki
 * karşılık `extensions/bg-hbmon.ts` `promptGuidelines`/`completionGuidance`.
 */

import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"
import { closeSync, openSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveHbmonBin, runHbmon, statusBuild, waitBuild, watchBuild } from "nabiz-core/hbmon-tools"
import { HBMON_DISABLED_SENTINEL, HBMON_DISABLED_TEXT } from "nabiz-core/hbmon-disclosure"
import {
  bgDir,
  claimWake,
  createOffsetTracker,
  formatCursorReceipt,
  isTerminalState,
  outFromSock,
  readLastEvent,
  readOutCursor,
  readOutTail,
  releaseWake,
  resolveRecord,
  shellArgv,
  wakeMessage,
  writeRecord,
} from "nabiz-core/bg-tasks"
import { formatProgress, readLastProgress } from "nabiz-core/progress"
import { resolveEventDirs } from "nabiz-core/settle-notice"
import { adaptToolInfo } from "./lib/opencode-compat.js"

interface HbmonPluginConfig {
  enabled?: boolean
  /** HBMON_BIN yerine geçecek ikilik yolu (boşsa env/PATH). */
  bin?: string
  /** wait default daemon tavanı, saniye (gateway altı tut). */
  defaultTimeoutSec?: number
  /** bg wake bekçi scripti (boşsa repo scripts/bg-wake.mjs). */
  wakeScript?: string
}

/** V2 ToolContext — promise yüzeyi (test ile birebir aynı şekil). */
interface ToolContext {
  sessionID: string
  agent: string
  messageID: string
  id: string
  signal: AbortSignal
  progress(update: Record<string, unknown>): Promise<void> | void
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** Native push beklercisi dilimleri: daemon-side bloklu bekleme (polling değil). */
const WAIT_SLICE_SEC = 50
/** Native push ömrü — bu süre içinde terminal olmazsa bekçi tek başına kalır. */
const NATIVE_PUSH_MAX_WAIT_SEC = 4 * 60 * 60

/**
 * Bekleme yardımcısı — timer UNREF'li: native push beklercisi
 * boşta beklerken event loop'u tutmaz (opencode çıkışı + node --test
 * sonrası temiz çıkış; canlı kanıt: sonsuz beklçi yüzünden
 * test süreci çıkamıyordu).
 */
/** .out dosyasının boyutu (yoksa undefined) — wait_ms büyüme tabanı. */
function outFileSize(path: string): number | undefined {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })
}

/** bg_logs wait_ms tavanı (pi ile aynı): istek üstü sessizce kırpılır, hint bildirilir. */
const WAIT_CAP_MS = 30000
/** Bekleme dilimi: daemon-side bloklu bekleme (polling değil). */
const WAIT_SLICE_MS = 5000

/** Native push hata bütçesi: bu kadar ardışık hata sonra beklerci bırakır. */
const NATIVE_PUSH_MAX_ERRORS = 3

function systemText(s: unknown): string {
  if (typeof s === "string") return s
  if (s != null && typeof s === "object" && "text" in (s as Record<string, unknown>)) {
    return String((s as Record<string, unknown>).text ?? "")
  }
  return ""
}

const DEFAULT_CONFIG: HbmonPluginConfig = {
  enabled: true,
  bin: undefined,
  defaultTimeoutSec: 50,
}

/**
 * Bekçi script yolu.
 * V2'de plugin KAYNAK .ts'den yüklenir (dist'ten değil); `import.meta.url`
 * tabanlı sabit `../../scripts` göreli yolu paket dışına taşar
 * (canlı kanıt 2026-09-25: `/root/nabiz/packages/scripts/bg-wake.mjs`
 * MODULE_NOT_FOUND). Modül dizininden yukarı doğru `scripts/bg-wake.mjs`
 * aranır — hem kaynak (`plugins/`) hem derli (`dist/plugins/`) yerleşimde
 * bulur. Config `wakeScript` mutlak yolu her zaman önceliklidir.
 */
function resolveWakeScript(configured: unknown, moduleUrl: string): string {
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim()
  let dir = dirname(fileURLToPath(moduleUrl))
  for (let i = 0; i < 4; i++) {
    const cand = join(dir, "scripts", "bg-wake.mjs")
    try {
      if (statSync(cand).isFile()) return cand
    } catch {
      /* üst dizine */
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return fileURLToPath(new URL("../../scripts/bg-wake.mjs", moduleUrl))
}

/** NABIZ-001 tekrar tespiti: istenen offset, task başına (bellekte; NABIZ-002'ye kadar). */
const offsetTracker = createOffsetTracker()

/**
 * bg_* disiplin metni — `opencode-bm` `DISCIPLINE_TEXT` karşılığı
 * (`mcp.bm` Faz 5'te söküldü, `docs/migration-plan.md`; bu yüzey devraldı).
 *
 * bm'de metin hem tool açıklamasına hem her yanıta gömülüyordu. opencode'da
 * `promptGuidelines` yok (pi API'si) ve push kanalı zaten var (bg-wake +
 * settle-noticer) — bu yüzden "busy-poll yapma" tekrarı yerine sıradaki adım
 * yanıta konur: bekleme bildirimle gelir, yoksa seyrek yoklama gerekir.
 * pi tarafındaki karşılık `extensions/bg-hbmon.ts` `promptGuidelines` +
 * `completionGuidance` (orada `wait_ms` bloklaması da var).
 */
const BG_NEXT_PUSH =
  "Sıradaki adım: poll/sleep YAPMA. Bağımsız işin varsa onu yap, yoksa turn'ü bitir — terminal durumda aynı oturumda yeni turn açılır."
const BG_NEXT_MANUAL =
  "Sıradaki adım: uyandırma kurulmadı, bildirim gelmeyecek; bekleme aracı da yok (pi'deki `wait_ms` eşdeğeri bu yüzeyde bulunmuyor) — seyrek `bg_status`/`bg_logs` ile kontrol et."
const BG_COLLECT =
  "Final cevaptan önce hâlâ ilgili görevleri `bg_logs` (offset) ile topla; ilgisi kalmayanı `bg_kill` ile durdur."
const BG_STATUS_NOTE = "Anlık görüntü — bekleme aracı değil; bildirim gelene kadar döngü kurma."
const BG_LOGS_NEXT = "Yeni çıktı için bir sonraki `next_offset` değerini kullan; aynı offset'i tekrar çağırma."

/**
 * Bekçi scriptini koşturacak JS runtime'ı.
 * V1'de `process.execPath` yeterliydi (bun); V2'de plugin host opencode
 * binary'sinin içindedir — execPath script ÇALIŞTIRAMAZ
 * ("Unrecognized flag: --sock in command opencode", canlı kanıt 2026-09-25).
 * Sıra: `NABIZ_WAKE_NODE` override → execPath node/bun/deno ise o →
 * PATH'teki `node`.
 */
function resolveWakeNodeBin(): string {
  const override = process.env.NABIZ_WAKE_NODE?.trim()
  if (override) return override
  const base = basename(process.execPath)
  if (/^(node|bun|deno)(\.exe)?$/i.test(base)) return process.execPath
  return "node"
}

/**
 * Native push beklercisi: `bg_run` anında başlar, hbmon terminal olayını
 * daemon-side bekler, sonra `session.synthetic` ile AYNI oturuma bildirim
 * düşürür (inbox kaydı + `execution.wake` = yeni turn).
 *
 * Neden ayrıca detached bekçi de var: opencode süreci (TUI kapatma, restart)
 * görev bitmeden ölürse in-process bekleme de düşer. Bekçi kalıcılık sağlar,
 * claim marker'ı (`claimWake`) çift bildirimi engeller. Native push claim'ı
 * sahiplenip başarısız olursa claim'i bırakır → bekçi devralır.
 */
async function pushOnSettle(
  bin: string,
  task: { uuid: string; sock: string; log: string; name: string; sessionID: string },
  push: (text: string) => Promise<void>,
): Promise<void> {
  const dir = bgDir()
  const deadline = Date.now() + NATIVE_PUSH_MAX_WAIT_SEC * 1000
  let errors = 0
  for (;;) {
    const slice = Math.max(5, Math.min(WAIT_SLICE_SEC, Math.ceil((deadline - Date.now()) / 1000)))
    const w = await waitBuild(bin, task.sock, { timeoutSec: slice })
    // waitBuild yanıtı `unknown`; terminal state alanları daemon JSON'undan.
    const ev = (w.response ?? {}) as { state?: unknown; code?: unknown }
    const state = typeof ev.state === "string" ? ev.state : ""
    const code = typeof ev.code === "number" ? ev.code : undefined
    if (isTerminalState(state)) {
      if (!claimWake(dir, task.uuid)) return
      try {
        await push(`${wakeMessage(task.name, state, code)} [wake:${task.uuid}]`)
      } catch (e) {
        releaseWake(dir, task.uuid)
        console.error(`nabiz: native push BAŞARISIZ (bekçi devralır): ${e instanceof Error ? e.message : String(e)}`)
      }
      return
    }
    if (Date.now() >= deadline) return
    // Daemon öldü/yoksa (hata) sınırsız döngüye girme: bütçe
    // bıraktık sunucu kapalı demektir — kalıcı bekçi devralır.
    if (w.error && ++errors >= NATIVE_PUSH_MAX_ERRORS) return
    if (w.error) await sleep(500)
  }
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})
const str = (description: string) => ({ type: "string", description })
const optStr = (description: string) => ({ type: "string", description })
const num = (description: string) => ({ type: "number", description })
const bool = (description: string) => ({ type: "boolean", description })

export default Plugin.define({
  id: "opencode-hbmon",
  async setup(ctx) {
    const config = {
      ...DEFAULT_CONFIG,
      ...((ctx.options ?? {}) as HbmonPluginConfig),
    }
    if (config.enabled === false) {
      // NABIZ-008: yapısal kill-switch — transform hiç çağrılmaz, 7 tool
      // kaydolmaz (build-tracker deseni). Tek görünür iz: neden-yok
      // disclosure'ı (diğer plugin'lerin yaptığı gibi context hook'u,
      // sentinel-idempotent, oturum açılışında bir kez).
      await ctx.session.hook("context", (event) => {
        if (event.system.some((s) => systemText(s).includes(HBMON_DISABLED_SENTINEL))) return
        event.system.push({ type: "text", text: HBMON_DISABLED_TEXT })
      })
      return
    }
    const bin = typeof config.bin === "string" && config.bin.trim() !== "" ? config.bin.trim() : resolveHbmonBin()
    const defaultTimeoutSec = config.defaultTimeoutSec ?? 50

    // Transform callback'i senkron olmalı (replayable state edit): dış veri
    // önceden yüklenir, closure'a yakalanır. Bin yolu + config yukarıda
    // çözüldü; execute gövdeleri async kalır (transform değil, executor).
    await ctx.tool.transform((editor) => {
      editor.add(
        adaptToolInfo({
          name: "hbmon_watch",
          description:
            "Uzun build (>2dk) turn-içi takip: komutu hbmon ile arka planda başlat, hemen dön (bash'te bloklama). Dönen sock'u sonraki hbmon_wait/hbmon_status çağrılarına ver. Burada bekleyeceksen bunu seç (next-contact için build-mon kullan). Argv dizisi ver, shell yok.",
          input: obj(
            {
              command: {
                type: "array",
                items: { type: "string" },
                description: "Build komutu argv dizisi, örn. ['cargo','build','--release']",
              },
              uuid: { ...optStr("İzleyici kimliği (boşsa üretilir)") },
              timeout_sec: { ...num("Derleme tavanı sn (aionra SIGTERM→SIGKILL, exit 124)") },
            },
            ["command"],
          ),
          options: { namespace: "build_pulse" },
          async execute(input) {
            const args = input as { command: string[]; uuid?: string; timeout_sec?: number }
            const w = await watchBuild(bin, args.command, {
              uuid: args.uuid,
              timeoutSec: args.timeout_sec,
            })
            if (!w.handshake) return { content: `hbmon_watch BAŞARISIZ: ${w.error}` }
            return {
              content: [
                `hbmon_watch OK uuid=${w.handshake.uuid}`,
                `sock=${w.handshake.sock}`,
                `log=${w.handshake.log}`,
                "Sonra: hbmon_wait (bekle) veya hbmon_status (yokla).",
              ].join("\n"),
            }
          },
        }),
      )

      editor.add(
        adaptToolInfo({
          name: "hbmon_wait",
          description:
            "Sock'lu build bitene kadar bloklanarak bekle (polling YOK — bu çağrı uyandırır). Daemon tavanı default 50s (gateway ~60s altı); `timeout (hâlâ çalışıyor)` dönerse aynı sock ile tekrar çağır. Erken-dönüş için until: done,failed,dep_missing,stall_suspect,oom_suspect,timeout (virgüllü). dep_missing dönerse bekleme, log'a bak.",
          input: obj(
            {
              sock: str("hbmon_watch'tan dönen sock"),
              timeout: { ...num(`Daemon tavanı sn (default ${DEFAULT_CONFIG.defaultTimeoutSec}, gateway altı tut)`) },
              until: {
                ...optStr("Erken-dönüş sinyalleri, virgüllü (done,dep_missing,stall_suspect). Yoksa yalnızca bitiş."),
              },
            },
            ["sock"],
          ),
          options: { namespace: "build_pulse" },
          async execute(input, context) {
            const args = input as { sock: string; timeout?: number; until?: string }
            const signal = (context as ToolContext | undefined)?.signal
            const w = await waitBuild(bin, args.sock, {
              timeoutSec: args.timeout ?? defaultTimeoutSec,
              until: args.until,
              signal,
            })
            // Faz 8: progress bildirimi — NABIZ-005 ile aynı kaynak.
            if (w.response !== undefined && context) {
              const r = w.response as Record<string, unknown>
              if (typeof r.state === "string" && r.state === "running") {
                void context.progress({ state: "running", sock: args.sock }).catch(() => {})
              }
            }
            const body = w.response !== undefined ? JSON.stringify(w.response) : ""
            return { content: body === "" ? w.summary : `${w.summary}\n${body}` }
          },
        }),
      )

      editor.add(
        adaptToolInfo({
          name: "hbmon_status",
          description:
            "Sock'lu build'in anlık özeti (ağaç+metrik+sağlık). Hızlı yoklama, beklemez. hbmon_wait `woke_on=... state=running/stalled` dönerse detaya bununla bak.",
          input: obj({ sock: str("hbmon_watch'tan dönen sock") }, ["sock"]),
          options: { namespace: "build_pulse" },
          async execute(input, context) {
            const args = input as { sock: string }
            const signal = (context as ToolContext | undefined)?.signal
            const s = await statusBuild(bin, args.sock, process.env, 10000, false, signal)
            if (!s.response) return { content: `hbmon_status BAŞARISIZ: ${s.error}` }
            return { content: JSON.stringify(s.response) }
          },
        }),
      )

      editor.add(
        adaptToolInfo({
          name: "bg_run",
          description:
            "Uzun işi arka plana at, HEMEN dön (bloklama yok). LLM serbest kalır: başka iş yap veya turn'ü bitir; iş bitince bekçi aynı oturumda yeni turn açar (`opencode run -s`, uyandırma başına bir LLM turn'ü maliyeti). Kapatmak için notify:false (o zaman bg_status ile yokla). Komut bash -c ile koşar.",
          input: obj(
            {
              name: str("Görev adı (harf/rakam/_.-, max 64)"),
              command: str("Arka planda koşacak bash komutu"),
              notify: { ...bool("Bitince aynı oturumu uyandır (default true)") },
              timeout_sec: { ...num("İş tavanı sn (aionra SIGTERM→SIGKILL)") },
            },
            ["name", "command"],
          ),
          options: { namespace: "build_pulse" },
          async execute(input, context) {
            const args = input as { name: string; command: string; notify?: boolean; timeout_sec?: number }
            if (!NAME_RE.test(args.name)) {
              return { content: "bg_run HATA: `name` /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/ uymalı" }
            }
            const notify = args.notify ?? true
            const w = await watchBuild(bin, shellArgv(args.command), {
              timeoutSec: args.timeout_sec,
              label: args.name,
            })
            if (!w.handshake) return { content: `bg_run BAŞARISIZ: ${w.error}` }
            const h = w.handshake
            const dir = bgDir()
            const sessionID = (context as ToolContext | undefined)?.sessionID ?? ""
            const out = h.log.endsWith(".jsonl") ? h.log.slice(0, -6) + ".out" : outFromSock(h.sock)
            writeRecord(dir, {
              v: 1,
              name: args.name,
              uuid: h.uuid,
              sock: h.sock,
              log: h.log,
              out,
              sessionID,
              notify,
              createdAt: new Date().toISOString(),
            })
            const lines = [
              `bg_run OK id=${h.uuid} name=${args.name}`,
              `İzle: bg_status/bg_logs/bg_kill (id veya name ile).`,
            ]
            if (notify && sessionID !== "") {
              const wake = resolveWakeScript(config.wakeScript, import.meta.url)
              try {
                const wakeLog = join(dir, `bg-${h.uuid}.wake.log`)
                const outFd = openSync(wakeLog, "a")
                // win32 .cmd kuralı (runHbmon ile aynı: yalnızca test
                // shim'leri; gerçek runtime her zaman node .exe — Node .cmd'yi
                // doğrudan spawn edemez, ComSpec DOĞRUDAN spawn edilir).
                let wakeBin = resolveWakeNodeBin()
                let wakeArgs = [
                  wake,
                  "--session",
                  sessionID,
                  "--sock",
                  h.sock,
                  "--log",
                  h.log,
                  "--name",
                  args.name,
                  // native push düşürürse bekçi enjeksiyon yapmaz (çift bildirim yok)
                  "--claim-dir",
                  dir,
                  "--claim-uuid",
                  h.uuid,
                ]
                if (process.platform === "win32" && /\.(cmd|bat)$/i.test(wakeBin)) {
                  wakeArgs = ["/d", "/c", wakeBin, ...wakeArgs]
                  wakeBin = process.env.ComSpec ?? "cmd.exe"
                }
                const child = spawn(wakeBin, wakeArgs, {
                  // win32: detached dosya-fd çıktıyı yutar (boş log, ölçüldü) —
                  // Windows çocuğu zaten ebeveynden bağımsız yaşatır, detached
                  // gerekmez. windowsHide konsol parlamasını önler (POSIX'te
                  // yoksayılır).
                  detached: process.platform !== "win32",
                  stdio: ["ignore", outFd, outFd],
                  windowsHide: true,
                })
                child.unref()
                closeSync(outFd)
                // Native yol: süreç ayakta kaldığı sürece in-process bekleme +
                // session.synthetic (inbox + execution.wake). Bekçi yalnız
                // kalıcılık yedeği; claim marker'ı ikisini ayırır.
                void pushOnSettle(bin, { uuid: h.uuid, sock: h.sock, log: h.log, name: args.name, sessionID }, (text) =>
                  ctx.session.synthetic({ sessionID, text, delivery: "steer" }).then(() => undefined),
                )
                lines.push(
                  `Uyandırma kuruldu: bitince bu oturumda yeni turn açılır (native synthetic + kalıcılık bekçisi).`,
                )
                lines.push(`Bekçi logu: ${wakeLog}`)
              } catch {
                lines.push(`Bekçi kurulamadı (wake atlandı); bg_status ile yokla.`)
              }
            } else if (notify) {
              lines.push(`sessionID yok — uyandırma kurulamadı; bg_status ile yokla.`)
            } else {
              lines.push(`notify:false — uyandırma yok; bg_status ile yokla.`)
            }
            lines.push(notify && sessionID !== "" ? BG_NEXT_PUSH : BG_NEXT_MANUAL, BG_COLLECT)
            return { content: lines.join("\n") }
          },
        }),
      )

      editor.add(
        adaptToolInfo({
          name: "bg_status",
          description:
            "Arka plan görevinin anlık özeti (compact). Beklemez ve bekleme aracı değildir — terminal bildirimi bekleniyorsa tekrar çağırma. id: name veya uuid-prefix.",
          input: obj({ id: str("Görev name veya uuid-prefix (bg_run'dan döner)") }, ["id"]),
          options: { namespace: "build_pulse" },
          async execute(input, context) {
            const args = input as { id: string }
            const r = resolveRecord(bgDir(), args.id)
            if (!r.record) {
              const prog = readLastProgress(resolveEventDirs(undefined, process.env, process.cwd()), args.id)
              if (prog) return { content: `name=${args.id} ${formatProgress(prog)} (build-mon izlemesi)` }
              return { content: `bg_status HATA: ${r.error}` }
            }
            const signal = (context as ToolContext | undefined)?.signal
            const s = await statusBuild(bin, r.record.sock, process.env, 10000, true, signal)
            if (!s.response) {
              const ev = readLastEvent(r.record.log)
              if (ev && isTerminalState(ev.state)) {
                const dur = typeof ev.duration_sec === "number" ? ` in ${ev.duration_sec.toFixed(1)}s` : ""
                return {
                  content: `name=${r.record.name} ${ev.state} code=${ev.code ?? "?"}${dur} (monitör kapanmış, log'dan)`,
                }
              }
              return { content: `bg_status name=${r.record.name} BAŞARISIZ: ${s.error}` }
            }
            return { content: `name=${r.record.name} ${JSON.stringify(s.response)}\n${BG_STATUS_NOTE}` }
          },
        }),
      )

      editor.add(
        adaptToolInfo({
          name: "bg_logs",
          description:
            "Arka plan görevinin stdout kuyruğu (.out tail, tail modunda max 512KB). id: name veya uuid-prefix. Artımlı okuma için offset ver (önceki yanıtın next_offset'i); aynı offset tekrarı uyarı döndürür. Cursor (offsetli) modda tavan 50KB — üstü kırpılır, receipt'te capped ile bildirilir. wait_ms>0 verilirse bloklayan okuma yapar: yeni çıktı veya terminal durum gelene kadar bekler (cap 30000).",
          input: obj(
            {
              id: str("Görev name veya uuid-prefix (bg_run'dan döner)"),
              tail_bytes: {
                ...num(
                  "Kuyruk baytı (default 51200; tail modunda max 512000, cursor modunda max 51200 — üstü capped ile kırpılır)",
                ),
              },
              offset: { ...num("Artımlı okuma bayt konumu (önceki yanıtın next_offset'i; yoksa tail modu)") },
              wait_ms: {
                ...num(
                  "Bloklayan okuma: yeni çıktı veya terminal durum gelene kadar bekle (cap 30000, aşım kırpılır + hint). Bildirim beklerken döngü kurmak yerine tek çağrıda bekle.",
                ),
              },
            },
            ["id"],
          ),
          options: { namespace: "build_pulse" },
          async execute(input, context) {
            const args = input as { id: string; tail_bytes?: number; offset?: number; wait_ms?: number }
            const r = resolveRecord(bgDir(), args.id)
            if (!r.record) return { content: `bg_logs HATA: ${r.error}` }
            const rec = r.record
            const requested = typeof args.wait_ms === "number" && args.wait_ms > 0 ? Math.floor(args.wait_ms) : 0
            const budget = Math.min(requested, WAIT_CAP_MS)
            const clipped = requested > WAIT_CAP_MS

            const read = (): string => {
              if (args.offset === undefined) {
                const tail = Math.min(Math.max(args.tail_bytes ?? 50 * 1024, 1), 512 * 1024)
                const out = readOutTail(rec.out, tail)
                return `[${rec.name} .out${out.truncated ? " (TRUNCATED, kuyruk)" : ""}]\n${out.text}`
              }
              const repeat = offsetTracker.note(rec.uuid, args.offset)
              const cur = readOutCursor(rec.out, args.offset, args.tail_bytes ?? 50 * 1024)
              const head = repeat
                ? `[tekrar] yeni çıktı yok; bekle ya da bildirimi bekle (offset=${args.offset})\n`
                : ""
              return head + formatCursorReceipt(rec.name, args.offset, cur, cur.text)
            }

            let body = read()
            let wake = "immediate"
            if (budget > 0) {
              // Bekleme tabanı: cursor modunda istenen offset, tail modunda giriş
              // boyutu. Terminal tespiti log'dan (daemon kapanmış olsa da çalışır).
              const signal = (context as ToolContext | undefined)?.signal
              const baseline = args.offset === undefined ? outFileSize(rec.out) : Math.max(0, Math.floor(args.offset))
              const t0 = Date.now()
              wake = "timeout"
              for (;;) {
                const remaining = budget - (Date.now() - t0)
                if (remaining <= 0 || signal?.aborted) break
                const sliceSec = Math.max(1, Math.ceil(Math.min(WAIT_SLICE_MS, remaining) / 1000))
                await waitBuild(bin, rec.sock, {
                  timeoutSec: sliceSec,
                  until: "done,failed,dep_missing,timeout",
                  signal,
                })
                const ev = readLastEvent(rec.log)
                const nowSize = outFileSize(rec.out)
                const grew =
                  nowSize !== undefined && nowSize > 0 && (baseline === undefined ? nowSize > 0 : nowSize > baseline)
                if (isTerminalState(ev?.state)) {
                  wake = "terminal"
                  break
                }
                if (grew) {
                  wake = "new-output"
                  break
                }
              }
              body = read()
              const effective = Date.now() - t0
              body +=
                `\n(wait_ms=${requested}${clipped ? `→${budget} (cap ${WAIT_CAP_MS}'e kırpıldı)` : ""}` +
                ` effective_wait_ms=${effective} timed_out=${wake === "timeout"} wake=${wake})`
            }
            // Cursor modunda zincir disiplini (next_offset), tail modunda toplama
            // hatırlatması; bloklayan bekleme döndüyse bekleme ipucu da düşer.
            const advice =
              args.offset !== undefined
                ? BG_LOGS_NEXT
                : wake === "timeout"
                  ? `${BG_LOGS_NEXT} ${BG_COLLECT}`
                  : BG_COLLECT
            return { content: `${body}\n${advice}` }
          },
        }),
      )

      editor.add(
        adaptToolInfo({
          name: "bg_kill",
          description: "Arka plan görevini öldür (process group, TERM). id: name veya uuid-prefix.",
          input: obj({ id: str("Görev name veya uuid-prefix (bg_run'dan döner)") }, ["id"]),
          options: { namespace: "build_pulse" },
          async execute(input) {
            const args = input as { id: string }
            const r = resolveRecord(bgDir(), args.id)
            if (!r.record) return { content: `bg_kill HATA: ${r.error}` }
            offsetTracker.forget(r.record.uuid)
            const k = await runHbmon(bin, ["kill", "--sock", r.record.sock], 30000)
            if (k.code !== 0)
              return {
                content: `bg_kill name=${r.record.name} BAŞARISIZ (exit ${k.code}): ${(k.stderr || k.stdout).trim().slice(0, 300)}`,
              }
            return { content: `bg_kill OK name=${r.record.name} — bg_status ile teyit et.` }
          },
        }),
      )
    })
  },
})
