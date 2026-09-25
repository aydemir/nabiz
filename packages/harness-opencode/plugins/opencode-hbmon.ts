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
 * uyumluluğu); namespace yok.
 */

import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  resolveHbmonBin,
  runHbmon,
  statusBuild,
  waitBuild,
  watchBuild,
} from "nabiz-core/hbmon-tools"
import {
  bgDir,
  createOffsetTracker,
  formatCursorReceipt,
  isTerminalState,
  outFromSock,
  readLastEvent,
  readOutCursor,
  readOutTail,
  resolveRecord,
  writeRecord,
} from "nabiz-core/bg-tasks"

interface HbmonPluginConfig {
  enabled?: boolean
  /** HBMON_BIN yerine geçecek ikilik yolu (boşsa env/PATH). */
  bin?: string
  /** wait default daemon tavanı, saniye (gateway altı tut). */
  defaultTimeoutSec?: number
  /** bg wake bekçi scripti (boşsa repo scripts/bg-wake.mjs). */
  wakeScript?: string
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

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
  let dir = path.dirname(fileURLToPath(moduleUrl))
  for (let i = 0; i < 4; i++) {
    const cand = path.join(dir, "scripts", "bg-wake.mjs")
    try {
      if (fs.statSync(cand).isFile()) return cand
    } catch { /* üst dizine */ }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return fileURLToPath(new URL("../../scripts/bg-wake.mjs", moduleUrl))
}

/** NABIZ-001 tekrar tespiti: istenen offset, task başına (bellekte; NABIZ-002'ye kadar). */
const offsetTracker = createOffsetTracker()

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
  const base = path.basename(process.execPath)
  if (/^(node|bun|deno)(\.exe)?$/i.test(base)) return process.execPath
  return "node"
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
    const bin =
      typeof config.bin === "string" && config.bin.trim() !== ""
        ? config.bin.trim()
        : resolveHbmonBin()
    const defaultTimeoutSec = config.defaultTimeoutSec ?? 50

    // Transform callback'i senkron olmalı (replayable state edit): dış veri
    // önceden yüklenir, closure'a yakalanır. Bin yolu + config yukarıda
    // çözüldü; execute gövdeleri async kalır (transform değil, executor).
    await ctx.tool.transform((editor) => {
      editor.add({
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
        async execute(input) {
          if (config.enabled === false) return { content: "hbmon_watch kapalı (enabled:false)" }
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
      })

      editor.add({
        name: "hbmon_wait",
        description:
          "Sock'lu build bitene kadar bloklanarak bekle (polling YOK — bu çağrı uyandırır). Daemon tavanı default 50s (gateway ~60s altı); `timeout (hâlâ çalışıyor)` dönerse aynı sock ile tekrar çağır. Erken-dönüş için until: done,failed,dep_missing,stall_suspect,oom_suspect,timeout (virgüllü). dep_missing dönerse bekleme, log'a bak.",
        input: obj(
          {
            sock: str("hbmon_watch'tan dönen sock"),
            timeout: { ...num(`Daemon tavanı sn (default ${DEFAULT_CONFIG.defaultTimeoutSec}, gateway altı tut)`) },
            until: { ...optStr("Erken-dönüş sinyalleri, virgüllü (done,dep_missing,stall_suspect). Yoksa yalnızca bitiş.") },
          },
          ["sock"],
        ),
        async execute(input) {
          if (config.enabled === false) return { content: "hbmon_wait kapalı (enabled:false)" }
          const args = input as { sock: string; timeout?: number; until?: string }
          const w = await waitBuild(bin, args.sock, {
            timeoutSec: args.timeout ?? defaultTimeoutSec,
            until: args.until,
          })
          const body = w.response !== undefined ? JSON.stringify(w.response) : ""
          return { content: body === "" ? w.summary : `${w.summary}\n${body}` }
        },
      })

      editor.add({
        name: "hbmon_status",
        description:
          "Sock'lu build'in anlık özeti (ağaç+metrik+sağlık). Hızlı yoklama, beklemez. hbmon_wait `woke_on=... state=running/stalled` dönerse detaya bununla bak.",
        input: obj({ sock: str("hbmon_watch'tan dönen sock") }, ["sock"]),
        async execute(input) {
          if (config.enabled === false) return { content: "hbmon_status kapalı (enabled:false)" }
          const args = input as { sock: string }
          const s = await statusBuild(bin, args.sock)
          if (!s.response) return { content: `hbmon_status BAŞARISIZ: ${s.error}` }
          return { content: JSON.stringify(s.response) }
        },
      })

      editor.add({
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
        async execute(input, context) {
          if (config.enabled === false) return { content: "bg_run kapalı (enabled:false)" }
          const args = input as { name: string; command: string; notify?: boolean; timeout_sec?: number }
          if (!NAME_RE.test(args.name)) {
            return { content: "bg_run HATA: `name` /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/ uymalı" }
          }
          const notify = args.notify ?? true
          const w = await watchBuild(bin, ["/bin/bash", "-c", args.command], {
            timeoutSec: args.timeout_sec,
            label: args.name,
          })
          if (!w.handshake) return { content: `bg_run BAŞARISIZ: ${w.error}` }
          const h = w.handshake
          const dir = bgDir()
          // V1'de tool execute ikinci argümanı `{ sessionID }` taşıyordu;
          // V2 ToolContext'te sessionID yine var.
          const sessionID = (context as unknown as { sessionID?: string } | undefined)?.sessionID ?? ""
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
            // wakeScript: config mutlak yolu > paket-içi arama (kaynak/dist
            // yerleşimden bağımsız). Bulunamazsa legacy göreli yol denenir;
            // spawn başarısızlığı yakalanır, yoklama yoluna düşülür.
            const wake = resolveWakeScript(config.wakeScript, import.meta.url)
            try {
              // Bekçi çıktısı dosyaya (kör nokta yok); process detached+unref.
              // Runtime: resolveWakeNodeBin (V2'de execPath opencode'dur).
              const wakeLog = path.join(dir, `bg-${h.uuid}.wake.log`)
              const outFd = fs.openSync(wakeLog, "a")
              const child = spawn(
                resolveWakeNodeBin(),
                [wake, "--session", sessionID, "--sock", h.sock, "--log", h.log, "--name", args.name],
                { detached: true, stdio: ["ignore", outFd, outFd] },
              )
              child.unref()
              fs.closeSync(outFd)
              lines.push(`Uyandırma kuruldu: bitince bu oturumda yeni turn açılır.`)
              lines.push(`Bekçi logu: ${wakeLog}`)
            } catch {
              lines.push(`Bekçi kurulamadı (wake atlandı); bg_status ile yokla.`)
            }
          } else if (notify) {
            lines.push(`sessionID yok — uyandırma kurulamadı; bg_status ile yokla.`)
          } else {
            lines.push(`notify:false — uyandırma yok; bg_status ile yokla.`)
          }
          return { content: lines.join("\n") }
        },
      })

      editor.add({
        name: "bg_status",
        description: "Arka plan görevinin anlık özeti (compact). Beklemez. id: name veya uuid-prefix.",
        input: obj({ id: str("Görev name veya uuid-prefix (bg_run'dan döner)") }, ["id"]),
        async execute(input) {
          if (config.enabled === false) return { content: "bg_status kapalı (enabled:false)" }
          const args = input as { id: string }
          const r = resolveRecord(bgDir(), args.id)
          if (!r.record) return { content: `bg_status HATA: ${r.error}` }
          const s = await statusBuild(bin, r.record.sock, process.env, 10000, true)
          if (!s.response) {
            // Monitör kapanmış olabilir — .jsonl son olay fallback'i.
            const ev = readLastEvent(r.record.log)
            if (ev && isTerminalState(ev.state)) {
              const dur = typeof ev.duration_sec === "number" ? ` in ${ev.duration_sec.toFixed(1)}s` : ""
              return { content: `name=${r.record.name} ${ev.state} code=${ev.code ?? "?"}${dur} (monitör kapanmış, log'dan)` }
            }
            return { content: `bg_status name=${r.record.name} BAŞARISIZ: ${s.error}` }
          }
          return { content: `name=${r.record.name} ${JSON.stringify(s.response)}` }
        },
      })

      editor.add({
        name: "bg_logs",
        description:
          "Arka plan görevinin stdout kuyruğu (.out tail, max 50KB). id: name veya uuid-prefix. Artımlı okuma için offset ver (önceki yanıtın next_offset'i); aynı offset tekrarı uyarı döndürür.",
        input: obj({
          id: str("Görev name veya uuid-prefix (bg_run'dan döner)"),
          tail_bytes: { ...num("Kuyruk baytı (default 51200, max 512000)") },
          offset: { ...num("Artımlı okuma bayt konumu (önceki yanıtın next_offset'i; yoksa tail modu)") },
        }, ["id"]),
        async execute(input) {
          if (config.enabled === false) return { content: "bg_logs kapalı (enabled:false)" }
          const args = input as { id: string; tail_bytes?: number; offset?: number }
          const r = resolveRecord(bgDir(), args.id)
          if (!r.record) return { content: `bg_logs HATA: ${r.error}` }
          if (args.offset === undefined) {
            const tail = Math.min(Math.max(args.tail_bytes ?? 50 * 1024, 1), 512 * 1024)
            const out = readOutTail(r.record.out, tail)
            return { content: `[${r.record.name} .out${out.truncated ? " (TRUNCATED, kuyruk)" : ""}]\n${out.text}` }
          }
          const repeat = offsetTracker.note(r.record.uuid, args.offset)
          const cur = readOutCursor(r.record.out, args.offset, args.tail_bytes ?? 50 * 1024)
          const head = repeat ? `[tekrar] yeni çıktı yok; bekle ya da bildirimi bekle (offset=${args.offset})\n` : ""
          return { content: head + formatCursorReceipt(r.record.name, args.offset, cur, cur.text) }
        },
      })

      editor.add({
        name: "bg_kill",
        description: "Arka plan görevini öldür (process group, TERM). id: name veya uuid-prefix.",
        input: obj({ id: str("Görev name veya uuid-prefix (bg_run'dan döner)") }, ["id"]),
        async execute(input) {
          if (config.enabled === false) return { content: "bg_kill kapalı (enabled:false)" }
          const args = input as { id: string }
          const r = resolveRecord(bgDir(), args.id)
          if (!r.record) return { content: `bg_kill HATA: ${r.error}` }
          offsetTracker.forget(r.record.uuid)
          const k = await runHbmon(bin, ["kill", "--sock", r.record.sock], 30000)
          if (k.code !== 0) return { content: `bg_kill name=${r.record.name} BAŞARISIZ (exit ${k.code}): ${(k.stderr || k.stdout).trim().slice(0, 300)}` }
          return { content: `bg_kill OK name=${r.record.name} — bg_status ile teyit et.` }
        },
      })
    })
  },
})
