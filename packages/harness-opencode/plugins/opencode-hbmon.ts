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
 * ⚠️ opencode 1.18.29 uyumluluğu: bu dosya sadece `default` export
 * yapıyor (getLegacyPlugins kuralı — bkz TASK-111). Mantık
 * `plugins/lib/hbmon-tools.ts` + `plugins/lib/bg-tasks.ts`'de.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
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

/** NABIZ-001 tekrar tespiti: istenen offset, task başına (bellekte; NABIZ-002'ye kadar). */
const offsetTracker = createOffsetTracker()

const HbmonPlugin: Plugin = async (_input, _options) => {
  const fromInput =
    ((_input as unknown as { config?: HbmonPluginConfig }).config ?? {}) as HbmonPluginConfig
  const fromOptions = ((_options ?? {}) as HbmonPluginConfig) as HbmonPluginConfig
  const config = { ...DEFAULT_CONFIG, ...fromInput, ...fromOptions }
  const bin =
    typeof config.bin === "string" && config.bin.trim() !== ""
      ? config.bin.trim()
      : resolveHbmonBin()

  return {
    tool: {
      hbmon_watch: tool({
        description:
          "Uzun build (>2dk) turn-içi takip: komutu hbmon ile arka planda başlat, hemen dön (bash'te bloklama). Dönen sock'u sonraki hbmon_wait/hbmon_status çağrılarına ver. Burada bekleyeceksen bunu seç (next-contact için build-mon kullan). Argv dizisi ver, shell yok.",
        args: {
          command: tool.schema
            .array(tool.schema.string())
            .describe("Build komutu argv dizisi, örn. ['cargo','build','--release']"),
          uuid: tool.schema.string().optional().describe("İzleyici kimliği (boşsa üretilir)"),
          timeout_sec: tool.schema
            .number()
            .optional()
            .describe("Derleme tavanı sn (aionra SIGTERM→SIGKILL, exit 124)"),
        },
        async execute(args) {
          if (config.enabled === false) return "hbmon_watch kapalı (enabled:false)"
          const w = await watchBuild(bin, args.command, {
            uuid: args.uuid,
            timeoutSec: args.timeout_sec,
          })
          if (!w.handshake) return `hbmon_watch BAŞARISIZ: ${w.error}`
          return [
            `hbmon_watch OK uuid=${w.handshake.uuid}`,
            `sock=${w.handshake.sock}`,
            `log=${w.handshake.log}`,
            "Sonra: hbmon_wait (bekle) veya hbmon_status (yokla).",
          ].join("\n")
        },
      }),

      hbmon_wait: tool({
        description:
          "Sock'lu build bitene kadar bloklanarak bekle (polling YOK — bu çağrı uyandırır). Daemon tavanı default 50s (gateway ~60s altı); `timeout (hâlâ çalışıyor)` dönerse aynı sock ile tekrar çağır. Erken-dönüş için until: done,failed,dep_missing,stall_suspect,oom_suspect,timeout (virgüllü). dep_missing dönerse bekleme, log'a bak.",
        args: {
          sock: tool.schema.string().describe("hbmon_watch'tan dönen sock"),
          timeout: tool.schema
            .number()
            .optional()
            .describe(`Daemon tavanı sn (default ${DEFAULT_CONFIG.defaultTimeoutSec}, gateway altı tut)`),
          until: tool.schema
            .string()
            .optional()
            .describe("Erken-dönüş sinyalleri, virgüllü (done,dep_missing,stall_suspect). Yoksa yalnızca bitiş."),
        },
        async execute(args) {
          if (config.enabled === false) return "hbmon_wait kapalı (enabled:false)"
          const w = await waitBuild(bin, args.sock, {
            timeoutSec: args.timeout ?? config.defaultTimeoutSec,
            until: args.until,
          })
          const body = w.response !== undefined ? JSON.stringify(w.response) : ""
          return body === "" ? w.summary : `${w.summary}\n${body}`
        },
      }),

      hbmon_status: tool({
        description: "Sock'lu build'in anlık özeti (ağaç+metrik+sağlık). Hızlı yoklama, beklemez. hbmon_wait `woke_on=... state=running/stalled` dönerse detaya bununla bak.",
        args: {
          sock: tool.schema.string().describe("hbmon_watch'tan dönen sock"),
        },
        async execute(args) {
          if (config.enabled === false) return "hbmon_status kapalı (enabled:false)"
          const s = await statusBuild(bin, args.sock)
          if (!s.response) return `hbmon_status BAŞARISIZ: ${s.error}`
          return JSON.stringify(s.response)
        },
      }),

      bg_run: tool({
        description:
          "Uzun işi arka plana at, HEMEN dön (bloklama yok). LLM serbest kalır: başka iş yap veya turn'ü bitir; iş bitince bekçi aynı oturumda yeni turn açar (`opencode run -s`, uyandırma başına bir LLM turn'ü maliyeti). Kapatmak için notify:false (o zaman bg_status ile yokla). Komut bash -c ile koşar.",
        args: {
          name: tool.schema.string().describe("Görev adı (harf/rakam/_.-, max 64)"),
          command: tool.schema.string().describe("Arka planda koşacak bash komutu"),
          notify: tool.schema.boolean().optional().describe("Bitince aynı oturumu uyandır (default true)"),
          timeout_sec: tool.schema.number().optional().describe("İş tavanı sn (aionra SIGTERM→SIGKILL)"),
        },
        async execute(args, context) {
          if (config.enabled === false) return "bg_run kapalı (enabled:false)"
          if (!NAME_RE.test(args.name)) {
            return "bg_run HATA: `name` /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/ uymalı"
          }
          const notify = args.notify ?? true
          const w = await watchBuild(bin, ["/bin/bash", "-c", args.command], {
            timeoutSec: args.timeout_sec,
            label: args.name,
          })
          if (!w.handshake) return `bg_run BAŞARISIZ: ${w.error}`
          const h = w.handshake
          const dir = bgDir()
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
            const wake =
              typeof config.wakeScript === "string" && config.wakeScript.trim() !== ""
                ? config.wakeScript.trim()
                : fileURLToPath(new URL("../../scripts/bg-wake.mjs", import.meta.url))
            try {
              // Bekçi çıktısı dosyaya (kör nokta yok); process detached+unref.
              const wakeLog = path.join(dir, `bg-${h.uuid}.wake.log`)
              const outFd = fs.openSync(wakeLog, "a")
              const child = spawn(
                process.execPath,
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
          return lines.join("\n")
        },
      }),

      bg_status: tool({
        description: "Arka plan görevinin anlık özeti (compact). Beklemez. id: name veya uuid-prefix.",
        args: {
          id: tool.schema.string().describe("Görev name veya uuid-prefix (bg_run'dan döner)"),
        },
        async execute(args) {
          if (config.enabled === false) return "bg_status kapalı (enabled:false)"
          const r = resolveRecord(bgDir(), args.id)
          if (!r.record) return `bg_status HATA: ${r.error}`
          const s = await statusBuild(bin, r.record.sock, process.env, 10000, true)
          if (!s.response) {
            // Monitör kapanmış olabilir — .jsonl son olay fallback'i.
            const ev = readLastEvent(r.record.log)
            if (ev && isTerminalState(ev.state)) {
              const dur = typeof ev.duration_sec === "number" ? ` in ${ev.duration_sec.toFixed(1)}s` : ""
              return `name=${r.record.name} ${ev.state} code=${ev.code ?? "?"}${dur} (monitör kapanmış, log'dan)`
            }
            return `bg_status name=${r.record.name} BAŞARISIZ: ${s.error}`
          }
          return `name=${r.record.name} ${JSON.stringify(s.response)}`
        },
      }),

      bg_logs: tool({
        description: "Arka plan görevinin stdout kuyruğu (.out tail, max 50KB). id: name veya uuid-prefix. Artımlı okuma için offset ver (önceki yanıtın next_offset'i); aynı offset tekrarı uyarı döndürür.",
        args: {
          id: tool.schema.string().describe("Görev name veya uuid-prefix (bg_run'dan döner)"),
          tail_bytes: tool.schema.number().optional().describe("Kuyruk baytı (default 51200, max 512000)"),
          offset: tool.schema.number().optional().describe("Artımlı okuma bayt konumu (önceki yanıtın next_offset'i; yoksa tail modu)"),
        },
        async execute(args) {
          if (config.enabled === false) return "bg_logs kapalı (enabled:false)"
          const r = resolveRecord(bgDir(), args.id)
          if (!r.record) return `bg_logs HATA: ${r.error}`
          if (args.offset === undefined) {
            const tail = Math.min(Math.max(args.tail_bytes ?? 50 * 1024, 1), 512 * 1024)
            const out = readOutTail(r.record.out, tail)
            return `[${r.record.name} .out${out.truncated ? " (TRUNCATED, kuyruk)" : ""}]\n${out.text}`
          }
          const repeat = offsetTracker.note(r.record.uuid, args.offset)
          const cur = readOutCursor(r.record.out, args.offset, args.tail_bytes ?? 50 * 1024)
          const head = repeat ? `[tekrar] yeni çıktı yok; bekle ya da bildirimi bekle (offset=${args.offset})\n` : ""
          return head + formatCursorReceipt(r.record.name, args.offset, cur, cur.text)
        },
      }),

      bg_kill: tool({
        description: "Arka plan görevini öldür (process group, TERM). id: name veya uuid-prefix.",
        args: {
          id: tool.schema.string().describe("Görev name veya uuid-prefix (bg_run'dan döner)"),
        },
        async execute(args) {
          if (config.enabled === false) return "bg_kill kapalı (enabled:false)"
          const r = resolveRecord(bgDir(), args.id)
          if (!r.record) return `bg_kill HATA: ${r.error}`
          offsetTracker.forget(r.record.uuid)
          const k = await runHbmon(bin, ["kill", "--sock", r.record.sock], 30000)
          if (k.code !== 0) return `bg_kill name=${r.record.name} BAŞARISIZ (exit ${k.code}): ${(k.stderr || k.stdout).trim().slice(0, 300)}`
          return `bg_kill OK name=${r.record.name} — bg_status ile teyit et.`
        },
      }),
    },
  }
}

export default HbmonPlugin
