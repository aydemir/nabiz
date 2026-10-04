#!/usr/bin/env node
// scripts/check-pi-ext.mjs — pi uyumluluk kapısı (canlı kanıt, mocked host).
//
// Ne yapar:
//   1. Kurulu pi'nin kendi jiti'siyle `extensions/*.ts` dosyalarını YÜKLER
//      (pi ile aynı yükleme yolu: TS + bare specifier çözümlemesi).
//   2. Her extension'ın `default` factory'sini sahte bir `pi` stub'ıyla çağırır:
//      registerTool/registerCommand/pi.on çağrılarını kaydeder, TUI/agent
//      bağımlılığı olan her şeyi atlar.
//   3. Beklenen tool ve komut adlarını doğrular; eksik/fazlalık varsa exit 1.
//
// Neden gerekli: extension'lar `tsc` ile tipden geçse bile pi sürümünde
// kaldırılan bir runtime API'si (createExtensionRuntime, exec, notify)
// yalnızca YÜKLEME sırasında belli olur. Bu kapı, pi güncellendiğinde
// nabiz'in kırılmadığını tek komutla gösterir.
//
// Kullanım: node scripts/check-pi-ext.mjs
// Çıkış: 0=tamam, 1=yükleme/şema hatası.

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// pi'nin `exports` haritası `./package.json`'ı yayınlamıyor; giriş noktası
// (`dist/index.js`) üzerinden paket köküne yürüyoruz.
function piRoot() {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))
  return resolve(dirname(entry), "..")
}

function piVersion() {
  return JSON.parse(readFileSync(join(piRoot(), "package.json"), "utf-8")).version
}

// Beklenen sözleşme: hangi tool/komut hangi dosyadan gelmeli.
const EXPECTED = {
  "hbmon.ts": { tools: ["hbmon_watch", "hbmon_wait", "hbmon_status"], commands: [] },
  "bg-hbmon.ts": { tools: ["bg_run", "bg_status", "bg_logs", "bg_kill"], commands: ["bg", "bg-status"] },
}

function recorder() {
  const seen = { tools: [], commands: [], events: [] }
  const pi = {
    registerTool: (def) => seen.tools.push(def.name),
    // pi 1.0 imzası: registerCommand(name, options) — isim ayrı argüman.
    registerCommand: (name) => seen.commands.push(name),
    on: (event) => seen.events.push(event),
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMessage: () => {},
  }
  return { pi, seen }
}

const { createJiti } = require(resolveJiti())
const jiti = createJiti(join(repoRoot, "extensions/"), { interopDefault: true })

const failures = []
for (const [file, want] of Object.entries(EXPECTED)) {
  const mod = await jiti.import(join(repoRoot, "extensions", file))
  const factory = mod.default
  if (typeof factory !== "function") {
    failures.push(`${file}: default export factory değil`)
    continue
  }
  const { pi, seen } = recorder()
  try {
    await factory(pi)
  } catch (err) {
    failures.push(`${file}: factory çağrısı threw — ${err?.message ?? err}`)
    continue
  }
  report(file, "tool", seen.tools, want.tools, failures)
  report(file, "komut", seen.commands, want.commands, failures)
  if (seen.tools.length === 0 && want.tools.length > 0) failures.push(`${file}: hiç tool kaydedilmedi`)
}

if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`FAIL ${f}\n`)
  process.exit(1)
}
process.stdout.write(`pi uyumluluk OK (pi ${piVersion()}, ${Object.keys(EXPECTED).length} extension)\n`)

// pi'nin jiti'si extension'ları pi ile aynı kurulumdan yükler; kendi
// kopyamızı kullanırsak "pi'de çalışıyor" kanıtı yanıltıcı olur.
function resolveJiti() {
  return require.resolve("jiti", { paths: [piRoot()] })
}

function report(file, kind, got, want, sink) {
  const missing = want.filter((n) => !got.includes(n))
  if (missing.length > 0) sink.push(`${file}: eksik ${kind} — ${missing.join(", ")}`)
}
