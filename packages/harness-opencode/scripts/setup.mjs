#!/usr/bin/env node
// scripts/setup.mjs — tamset kurulum: repo → canlı opencode config (V2).
//
// Ne yapar:
//   1. `dist/` artifact'lerini doğrular (yoksa/eskiyse `npm run build` ister).
//   2. Canlı config'e (`~/.config/opencode/opencode.jsonc`) `mcp.servers.nabiz`
//      bloğunu (mutlak server.js yoluyla) merge eder (eski `bash` key'inden
//      taşıma dahil). V2 şekli: sunucu düz `mcp.<name>` formunu OKUMAZ
//      (yalnız `mcp?.servers`, canlı kanıt 2026-10-02 / NABIZ-012), `enabled`
//      alanı da V2'de yok — kapatmak `disabled`. V1 düz girdi varsa okunur,
//      iç içe hedefe normalleştirilir.
//   3. Config'e paket dizinini (`plugin/`, tek entrypoint index.ts) yazar;
//      repo'ya ait stale dosya girdilerini temizler; eski symlink-modundan
//      kalan nabiz symlink'lerini kaldırır (çift kayıt önlenir).
//      (V2 gerçeği: `plugins` config girdisi DOSYA kabul etmez —
//      "configured plugin path must be a directory".)
//   4. Script setini (`build-mon.mjs`, `cpu-liveness-probe/`) kontrol eder.
//
// Yazma disiplini: bayraksız çalışınca SADECE plan yazdırır (exit 2).
// Gerçek yazma yalnızca `--yes` ile olur ve önce `.bak.<ts>` yedek alınır.
// `--dry-run` önizleme (yazmaz, exit 0), `--check` CI kapısıdır
// (değişiklik gerekirse exit 1, temizse exit 0).
//
// Çıkış kodları: 0=tamam/temiz, 1=hata (artifact yok, config parse hatası,
//   --check kirli, symlink çakışması), 2=plan gösterildi (bayraksız).
//
// Sınırlar (dürüst): config JSON.parse ile okunur — JSONC yorumları varsa
//   parse patlar ve script yazmadan çıkar (yorumları sessizce silmek yerine
//   fail-loud). Bu durumda `--config` ile yorumlu olmayan bir dosyaya
//   işaret edin veya yorumları elle temizleyin. `pluginOptions`'a DOKUNULMAZ
//   (mevcut kullanıcı ayarları korunur). Başkasına ait V1 `plugin` dosya
//   girdilerine DOKUNULMAZ (sadece repo'ya ait 6 yol temizlenir).
//   Discovery dizininde bizim basename'imizle NORMAL DOSYA varsa dokunulmaz
//   (symlink temizliği sadece hedefi bu repo olan symlink'leri kaldırır).
//
// Kullanım:
//   node scripts/setup.mjs [--yes | --dry-run | --check] [--config PATH]
//
// Örnek:
//   npm run setup -- --dry-run   # önce plansız yazmaz, önizle
//   npm run setup -- --yes       # yedekli yaz + symlink'le

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const USAGE = `scripts/setup.mjs — tamset kurulum (repo → canlı opencode config).
Kullanım:
  node scripts/setup.mjs [--yes | --dry-run | --check] [--config PATH]
Bayraksız çalışınca plan yazdırır, dosyaya dokunmaz (exit 2).`

export const MCP_KEY = "nabiz"

/** Eski `bash` key'i: sadece bizim dist'imizi gösteren girdi taşınır. */
export function isOursMcpEntry(e) {
  if (!e || typeof e !== "object") return false
  const cmd = e.command
  if (!Array.isArray(cmd)) return false
  return cmd.some((c) => typeof c === "string" && c.replaceAll("\\", "/").endsWith("mcp-bash-tools/src/server.js"))
}

const PLUGIN_FILES = [
  "plugins/opencode-context-saver.ts",
  "plugins/opencode-build-tracker.ts",
  "plugins/opencode-truncation-noticer.ts",
  "plugins/opencode-cpu-liveness.ts",
  "plugins/opencode-settle-noticer.ts",
  "plugins/opencode-hbmon.ts",
]

/** Tek-entrypoint V2 paket dizini (index.ts altıyı birden kaydolur). */
const PLUGIN_PACKAGE_DIR = "plugin"

export function packageDirFor(root) {
  return resolve(root, PLUGIN_PACKAGE_DIR)
}

const SCRIPT_FILES = [
  "scripts/build-mon.mjs",
  "scripts/hbmon-build-mon.mjs",
  "scripts/cpu-liveness-probe/cpu-liveness-agent.js",
]

const PACKAGE_FILES = ["plugin/package.json", "plugin/index.ts"]

const DIST_FILES = ["dist/plugins/server.js", "dist/plugins/mcp-bash-tools/src/server.js"]

export class SetupError extends Error {}

export function repoRoot(fromUrl = import.meta.url) {
  // packages/harness-opencode/scripts/setup.mjs → paket kökü bir üst dizin.
  return resolve(dirname(fileURLToPath(fromUrl)), "..")
}

export function defaultConfigPath() {
  return join(homedir(), ".config", "opencode", "opencode.jsonc")
}

function tsStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/**
 * Artifact + repo dosyası kontrolü. Eksik varsa fail-loud listesi döner
 * (çağıran `npm run build` önerir) — yarım kuruluma devam edilmez.
 */
export function checkRepo(root) {
  const missing = []
  for (const rel of [...DIST_FILES, ...PLUGIN_FILES, ...SCRIPT_FILES, ...PACKAGE_FILES]) {
    if (!existsSync(join(root, rel))) missing.push(rel)
  }
  return { ok: missing.length === 0, missing }
}

export function loadConfig(path) {
  if (!existsSync(path)) return { exists: false, config: {} }
  let raw
  try {
    raw = readFileSync(path, "utf8")
  } catch (e) {
    throw new SetupError(`config okunamadı: ${path} (${e.message})`)
  }
  try {
    const config = JSON.parse(raw)
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("kök obje değil")
    }
    return { exists: true, config }
  } catch {
    throw new SetupError(
      `config parse edilemedi (JSONC yorumu olabilir): ${path} — ` +
        `yorumları elle temizleyin veya --config ile düz JSON verin`,
    )
  }
}

function desiredMcpEntry(root) {
  // V2 şekli (NABIZ-012): `enabled` alanı V2'de YOK — kapatmak için
  // `disabled` kullanılır. Açık sunucu için alan hiç yazılmaz (fail-open
  // varsayılan: sunucu bağlanır).
  return {
    type: "local",
    command: ["node", join(root, "dist", "plugins", "mcp-bash-tools", "src", "server.js")],
  }
}

/**
 * Bir MCP girdisini V1 (düz `mcp.<name>`) ve V2 (`mcp.servers.<name>`)
 * iki yerden de okur. Sunucu 2.x düz şekli kendisi okumaz — V1→V2
 * migration katmanı yutuyor (canlı kanıt 2026-10-02: sunucu yalnız
 * `g.info.mcp?.servers` okuyor). Script iki şekli de tanıyıp **iç içe
 * hedefe** yazar; böylece bir kez normalize olur.
 *
 * Dönüş: `{ found, entry, shape }` — `shape` "v2" | "v1" | null
 * (bulunamadıysa). Kullanıcının kapatma tercihi iki şekilde de okunur
 * (`disabled:true` veya V1 `enabled:false`).
 */
export function readMcpEntry(config, key) {
  const mcp = config?.mcp
  const nested = mcp && typeof mcp === "object" && !Array.isArray(mcp) ? mcp.servers : undefined
  if (nested && typeof nested === "object" && !Array.isArray(nested) && nested[key]) {
    return { found: true, entry: nested[key], shape: "v2" }
  }
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp) && mcp[key]) {
    return { found: true, entry: mcp[key], shape: "v1" }
  }
  return { found: false, entry: undefined, shape: null }
}

/** Kullanıcının sunucuyu kapatma tercihi (V1 `enabled:false` ≡ V2 `disabled:true`). */
export function isMcpDisabled(entry) {
  if (!entry || typeof entry !== "object") return false
  if (entry.disabled === true) return true
  return entry.enabled === false
}

function sameMcp(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Hedef config'i hesaplar. Saf fonksiyondur (yazmaz) — testler ve
 * --dry-run/--check buradan beslenir.
 *
 * V2 (`opencode 2.x`) gerçeği: `plugins` config girdisi DOSYA kabul etmez
 * ("configured plugin path must be a directory"); dosya-form plugin'ler
 * sadece discovery dizinlerinden yüklenir. Bu yüzden config'e plugin
 * DOSYASI yazılmaz — PAKET DİZİNİ (`plugin/`, tek entrypoint index.ts)
 * yazılır; repo'ya ait STALE dosya girdileri (`plugin` V1 anahtarı +
 * `plugins` içindeki dosya-form girdiler) temizlenir. Yükleme işini
 * paket girdisi yapar (symlink gerekmez).
 * Başkasına ait girdilere DOKUNULMAZ. `pluginOptions`'a DOKUNULMAZ.
 */
export function computePlan(config, root) {
  const next = JSON.parse(JSON.stringify(config ?? {}))
  const changes = []

  if (!next.mcp || typeof next.mcp !== "object") next.mcp = {}
  // Hedef daima iç içe (V2). Düz V1 girişi kullanıcının elinde duruyorsa
  // silinir — iki yerde aynı sunucuyu tanımlamak çift kayıt riskidir;
  // opencode V1'i migration ile okusa da bizim yazdığımız tek giriş
  // iç içe olur.
  if (!next.mcp.servers || typeof next.mcp.servers !== "object" || Array.isArray(next.mcp.servers)) {
    next.mcp.servers = {}
  }
  // Key rename migrasyonu (`bash` → `nabiz`): SADECE bizim dist'imizi
  // gösteren girdi taşınır (başkasının bash MCP'sine dokunulmaz);
  // kapatma tercihi korunur.
  const bash = readMcpEntry(next, "bash")
  if (!readMcpEntry(next, MCP_KEY).found && bash.found && isOursMcpEntry(bash.entry)) {
    const keepDisabled = isMcpDisabled(bash.entry)
    delete next.mcp[MCP_KEY]
    delete next.mcp.bash
    delete next.mcp.servers.bash
    next.mcp.servers[MCP_KEY] = desiredMcpEntry(root)
    if (keepDisabled) next.mcp.servers[MCP_KEY].disabled = true
    changes.push(`mcp.bash → mcp.servers.${MCP_KEY} taşındı (key rename)`)
  }
  const wantMcp = desiredMcpEntry(root)
  const cur = readMcpEntry(next, MCP_KEY)
  if (!cur.found) {
    next.mcp.servers[MCP_KEY] = wantMcp
    changes.push(`mcp.servers.${MCP_KEY} eklenecek: ${wantMcp.command[1]}`)
  } else if (!sameMcp(cur.entry, wantMcp)) {
    // Komut yolu güncellenir ama kullanıcının kapatma tercihi korunur
    // (setup sessizce tekrar açmaz).
    const keepDisabled = isMcpDisabled(cur.entry)
    delete next.mcp[MCP_KEY]
    delete next.mcp.servers[MCP_KEY]
    next.mcp.servers[MCP_KEY] = wantMcp
    if (keepDisabled) next.mcp.servers[MCP_KEY].disabled = true
    if (cur.shape === "v1") changes.push(`mcp.${MCP_KEY} (V1 düz) → mcp.servers.${MCP_KEY} taşındı`)
    changes.push(`mcp.servers.${MCP_KEY} güncellenecek (komut yolu): ${wantMcp.command[1]}`)
  } else if (cur.shape === "v1") {
    // Komut yolu doğru ama giriş hâlâ düz V1: normalize et (idempotans
    // garantisi — ikinci `--check` temiz çıkar).
    delete next.mcp[MCP_KEY]
    next.mcp.servers[MCP_KEY] = cur.entry
    changes.push(`mcp.${MCP_KEY} (V1 düz) → mcp.servers.${MCP_KEY} normalleştirildi`)
  }

  // Repo'ya ait stale dosya girdilerini temizle (V1 `plugin` + V2 `plugins`
  // içindeki dosya-formları — ikisi de V2'de yüklenmez, yerini paket alır).
  const owned = new Set(PLUGIN_FILES.map((rel) => resolve(root, rel)))
  const isOwnedFileEntry = (e) => {
    if (typeof e === "string") return owned.has(resolve(e))
    if (e !== null && typeof e === "object" && !Array.isArray(e) && typeof e.package === "string") {
      return owned.has(resolve(e.package))
    }
    return false
  }
  for (const key of ["plugin", "plugins"]) {
    if (Array.isArray(next[key])) {
      const before = next[key].length
      next[key] = next[key].filter((e) => !isOwnedFileEntry(e))
      const dropped = before - next[key].length
      if (dropped > 0) {
        changes.push(`\`${key}\` içinden ${dropped} stale nabiz dosya girdisi temizlenecek (pakete taşındı)`)
      }
      if (next[key].length === 0) delete next[key]
    }
  }

  // Paket dizini tek girdidir.
  const pkg = packageDirFor(root)
  if (!Array.isArray(next.plugins)) next.plugins = []
  if (!next.plugins.includes(pkg)) {
    next.plugins.push(pkg)
    changes.push(`plugins eklenecek (paket dizini): ${pkg}`)
  }

  return { changes, next, dirty: changes.length > 0 }
}

/**
 * Discovery dizini: config dosyasının yanındaki `plugins/` klasörü.
 * Default config'te bu global discovery dizinidir
 * (`~/.config/opencode/plugins/`).
 */
export function discoveryDirFor(configPath) {
  return join(dirname(configPath), "plugins")
}

/**
 * Eski symlink-modundan kalan nabiz symlink'lerini bulur (saf — yazmaz).
 * Paket modunda bunlar ÇİFT KAYDA yol açar (aynı hook iki kez koşar);
 * kaldırılmalıdır. Sadece hedefi bu repo olan symlink'ler listelenir —
 * normal dosyalara ve yabancı symlink'lere DOKUNULMAZ.
 */
export function planSymlinkCleanup(root, configPath) {
  const dir = discoveryDirFor(configPath)
  const out = []
  for (const rel of PLUGIN_FILES) {
    const link = join(dir, basename(rel))
    let st
    try {
      st = lstatSync(link)
    } catch {
      continue
    }
    if (!st.isSymbolicLink()) continue
    let dest = null
    try {
      dest = resolve(dirname(link), readlinkSync(link))
    } catch {
      continue
    }
    if (dest === resolve(root, rel)) out.push({ link, target: dest })
  }
  return out
}

/** planSymlinkCleanup listesini kaldırır; kaldırılan yolları döndürür. */
export function applySymlinkCleanup(plans) {
  const removed = []
  for (const p of plans) {
    try {
      unlinkSync(p.link)
      removed.push(p.link)
    } catch {
      /* yarışta yoksa geç */
    }
  }
  return removed
}

/** Yedekli yazma: önce `.bak.<ts>`, sonra yeni config. Yedek yolunu döner. */
export function applyPlan(configPath, next) {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  let backup = null
  if (existsSync(configPath)) {
    backup = `${configPath}.bak.${tsStamp()}`
    copyFileSync(configPath, backup)
  }
  writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n")
  return backup
}

export function parseArgs(argv) {
  const opts = { mode: null, config: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--yes" || a === "--dry-run" || a === "--check") {
      if (opts.mode) throw new SetupError("tek mod bayrağı verin: --yes | --dry-run | --check")
      opts.mode = a.slice(2)
    } else if (a === "--config") {
      const v = argv[++i]
      if (!v) throw new SetupError("--config bir yol ister")
      opts.config = isAbsolute(v) ? v : resolve(process.cwd(), v)
    } else if (a === "--help" || a === "-h") {
      opts.mode = "help"
    } else {
      throw new SetupError(`bilinmeyen arg: ${a} (bkz --help)`)
    }
  }
  return opts
}

/** Test edilebilir çekirdek: argv → exit kodu. Girdi/çıktı enjeksiyonlu. */
export async function run(argv, deps = {}) {
  const root = deps.root ?? repoRoot()
  const configPath = deps.configPath ?? defaultConfigPath()
  const log = deps.log ?? ((m) => console.log(m))
  const err = deps.err ?? ((m) => console.error(m))

  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    err(`hata: ${e.message}\n\n${USAGE}`)
    return 1
  }
  if (opts.mode === "help") {
    log(USAGE)
    return 0
  }
  const cfgPath = opts.config ?? configPath

  const repo = checkRepo(root)
  if (!repo.ok) {
    err(`eksik artifact/dosya:\n  - ${repo.missing.join("\n  - ")}\nönce çalıştır: npm run build`)
    return 1
  }

  let loaded
  try {
    loaded = loadConfig(cfgPath)
  } catch (e) {
    err(`hata: ${e.message}`)
    return 1
  }

  const plan = computePlan(loaded.config, root)
  const staleLinks = planSymlinkCleanup(root, cfgPath)
  const linkChanges = staleLinks.map((l) => `eski symlink kaldırılacak (paket modu): ${l.link}`)
  const allChanges = [...plan.changes, ...linkChanges]
  if (allChanges.length === 0) {
    log(`temiz: ${cfgPath} güncel (paket girdisi + mcp, değişiklik yok)`)
    return 0
  }

  const head = loaded.exists
    ? `plan (${allChanges.length} değişiklik → ${cfgPath}):`
    : `plan (yeni config oluşturulacak → ${cfgPath}):`
  log([head, ...allChanges.map((c) => `  - ${c}`)].join("\n"))

  if (opts.mode === "dry-run") return 0
  if (opts.mode === "check") {
    err("kirli: config güncel değil (--yes ile uygula)")
    return 1
  }
  if (opts.mode !== "yes") {
    err("yazmak için --yes verin (önizleme: --dry-run)")
    return 2
  }

  const backup = applyPlan(cfgPath, plan.next)
  log(backup ? `yedek: ${backup}` : `oluşturuldu: ${cfgPath}`)
  log(`yazıldı: ${cfgPath}`)
  try {
    const removed = applySymlinkCleanup(staleLinks)
    for (const r of removed) log(`symlink kaldırıldı: ${r}`)
  } catch (e) {
    err(`hata: ${e.message}`)
    return 1
  }
  return 0
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const code = await run(process.argv.slice(2))
  process.exit(code)
}
