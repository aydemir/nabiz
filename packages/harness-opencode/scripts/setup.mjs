#!/usr/bin/env node
// scripts/setup.mjs — tamset kurulum: repo → canlı opencode config.
//
// Ne yapar:
//   1. `dist/` artifact'lerini doğrular (yoksa/eskiyse `npm run build` ister).
//   2. Canlı config'e (`~/.config/opencode/opencode.jsonc`) `mcp.bash` bloğunu
//      (mutlak server.js yoluyla) ve eksik `plugin` girdilerini merge eder.
//   3. Script setini (`build-mon.mjs`, `cpu-liveness-probe/`) kontrol eder.
//
// Yazma disiplini: bayraksız çalışınca SADECE plan yazdırır (exit 2).
// Gerçek yazma yalnızca `--yes` ile olur ve önce `.bak.<ts>` yedek alınır.
// `--dry-run` önizleme (yazmaz, exit 0), `--check` CI kapısıdır
// (değişiklik gerekirse exit 1, temizse exit 0).
//
// Çıkış kodları: 0=tamam/temiz, 1=hata (artifact yok, config parse hatası,
//   --check kirli), 2=plan gösterildi (bayraksız).
//
// Sınırlar (dürüst): config JSON.parse ile okunur — JSONC yorumları varsa
//   parse patlar ve script yazmadan çıkar (yorumları sessizce silmek yerine
//   fail-loud). Bu durumda `--config` ile yorumlu olmayan bir dosyaya
//   işaret edin veya yorumları elle temizleyin. `pluginOptions`'a DOKUNULMAZ
//   (mevcut kullanıcı ayarları korunur).
//
// Kullanım:
//   node scripts/setup.mjs [--yes | --dry-run | --check] [--config PATH]
//
// Örnek:
//   npm run setup -- --dry-run   # önce plansız yazmaz, önizle
//   npm run setup -- --yes       # yedekli yaz

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const USAGE = `scripts/setup.mjs — tamset kurulum (repo → canlı opencode config).
Kullanım:
  node scripts/setup.mjs [--yes | --dry-run | --check] [--config PATH]
Bayraksız çalışınca plan yazdırır, dosyaya dokunmaz (exit 2).`;

export const MCP_KEY = "bash";

const PLUGIN_FILES = [
  "plugins/opencode-context-saver.ts",
  "plugins/opencode-build-tracker.ts",
  "plugins/opencode-truncation-noticer.ts",
  "plugins/opencode-cpu-liveness.ts",
  "plugins/opencode-settle-noticer.ts",
  "plugins/opencode-hbmon.ts",
];

const SCRIPT_FILES = [
  "scripts/build-mon.mjs",
  "scripts/hbmon-build-mon.mjs",
  "scripts/cpu-liveness-probe/cpu-liveness-agent.js",
];

const DIST_FILES = [
  "dist/plugins/server.js",
  "dist/plugins/mcp-bash-tools/src/server.js",
];

export class SetupError extends Error {}

export function repoRoot(fromUrl = import.meta.url) {
  // packages/harness-opencode/scripts/setup.mjs → paket kökü bir üst dizin.
  return resolve(dirname(fileURLToPath(fromUrl)), "..");
}

export function defaultConfigPath() {
  return join(homedir(), ".config", "opencode", "opencode.jsonc");
}

function tsStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Artifact + repo dosyası kontrolü. Eksik varsa fail-loud listesi döner
 * (çağıran `npm run build` önerir) — yarım kuruluma devam edilmez.
 */
export function checkRepo(root) {
  const missing = [];
  for (const rel of [...DIST_FILES, ...PLUGIN_FILES, ...SCRIPT_FILES]) {
    if (!existsSync(join(root, rel))) missing.push(rel);
  }
  return { ok: missing.length === 0, missing };
}

export function loadConfig(path) {
  if (!existsSync(path)) return { exists: false, config: {} };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new SetupError(`config okunamadı: ${path} (${e.message})`);
  }
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("kök obje değil");
    }
    return { exists: true, config };
  } catch {
    throw new SetupError(
      `config parse edilemedi (JSONC yorumu olabilir): ${path} — ` +
        `yorumları elle temizleyin veya --config ile düz JSON verin`,
    );
  }
}

function desiredMcpEntry(root) {
  return {
    type: "local",
    command: ["node", join(root, "dist", "plugins", "mcp-bash-tools", "src", "server.js")],
    enabled: true,
  };
}

function sameMcp(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Hedef config'i hesaplar. Saf fonksiyondur (yazmaz) — testler ve
 * --dry-run/--check buradan beslenir. Mevcut kullanıcı anahtarlarına
 * dokunulmaz: sadece `mcp.bash` + 6 plugin girdisi merge edilir.
 */
export function computePlan(config, root) {
  const next = JSON.parse(JSON.stringify(config ?? {}));
  const changes = [];
  const abs = (rel) => resolve(root, rel);

  if (!next.mcp || typeof next.mcp !== "object") next.mcp = {};
  const wantMcp = desiredMcpEntry(root);
  if (!next.mcp[MCP_KEY]) {
    next.mcp[MCP_KEY] = wantMcp;
    changes.push(`mcp.${MCP_KEY} eklenecek: ${wantMcp.command[1]}`);
  } else if (!sameMcp(next.mcp[MCP_KEY], wantMcp)) {
    next.mcp[MCP_KEY] = wantMcp;
    changes.push(`mcp.${MCP_KEY} güncellenecek (komut yolu): ${wantMcp.command[1]}`);
  }

  if (!Array.isArray(next.plugin)) next.plugin = [];
  for (const rel of PLUGIN_FILES) {
    const p = abs(rel);
    if (!next.plugin.includes(p)) {
      next.plugin.push(p);
      changes.push(`plugin eklenecek: ${p}`);
    }
  }

  return { changes, next, dirty: changes.length > 0 };
}

/** Yedekli yazma: önce `.bak.<ts>`, sonra yeni config. Yedek yolunu döner. */
export function applyPlan(configPath, next) {
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });
  let backup = null;
  if (existsSync(configPath)) {
    backup = `${configPath}.bak.${tsStamp()}`;
    copyFileSync(configPath, backup);
  }
  writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
  return backup;
}

export function parseArgs(argv) {
  const opts = { mode: null, config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "--dry-run" || a === "--check") {
      if (opts.mode) throw new SetupError("tek mod bayrağı verin: --yes | --dry-run | --check");
      opts.mode = a.slice(2);
    } else if (a === "--config") {
      const v = argv[++i];
      if (!v) throw new SetupError("--config bir yol ister");
      opts.config = isAbsolute(v) ? v : resolve(process.cwd(), v);
    } else if (a === "--help" || a === "-h") {
      opts.mode = "help";
    } else {
      throw new SetupError(`bilinmeyen arg: ${a} (bkz --help)`);
    }
  }
  return opts;
}

/** Test edilebilir çekirdek: argv → exit kodu. Girdi/çıktı enjeksiyonlu. */
export async function run(argv, deps = {}) {
  const root = deps.root ?? repoRoot();
  const configPath = deps.configPath ?? defaultConfigPath();
  const log = deps.log ?? ((m) => console.log(m));
  const err = deps.err ?? ((m) => console.error(m));

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`hata: ${e.message}\n\n${USAGE}`);
    return 1;
  }
  if (opts.mode === "help") {
    log(USAGE);
    return 0;
  }
  const cfgPath = opts.config ?? configPath;

  const repo = checkRepo(root);
  if (!repo.ok) {
    err(`eksik artifact/dosya:\n  - ${repo.missing.join("\n  - ")}\nönce çalıştır: npm run build`);
    return 1;
  }

  let loaded;
  try {
    loaded = loadConfig(cfgPath);
  } catch (e) {
    err(`hata: ${e.message}`);
    return 1;
  }

  const plan = computePlan(loaded.config, root);
  if (plan.changes.length === 0) {
    log(`temiz: ${cfgPath} güncel (değişiklik yok)`);
    return 0;
  }

  const head = loaded.exists
    ? `plan (${plan.changes.length} değişiklik → ${cfgPath}):`
    : `plan (yeni config oluşturulacak → ${cfgPath}):`;
  log([head, ...plan.changes.map((c) => `  - ${c}`)].join("\n"));

  if (opts.mode === "dry-run") return 0;
  if (opts.mode === "check") {
    err("kirli: config güncel değil (--yes ile uygula)");
    return 1;
  }
  if (opts.mode !== "yes") {
    err("yazmak için --yes verin (önizleme: --dry-run)");
    return 2;
  }

  const backup = applyPlan(cfgPath, plan.next);
  log(backup ? `yedek: ${backup}` : `oluşturuldu: ${cfgPath}`);
  log(`yazıldı: ${cfgPath}`);
  return 0;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const code = await run(process.argv.slice(2));
  process.exit(code);
}
