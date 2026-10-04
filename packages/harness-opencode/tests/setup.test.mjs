/**
 * Tests for scripts/setup.mjs (TASK-130).
 *
 * Strateji: CLI spawn yerine `run()` çekirdeği doğrudan çağrılır
 * (hızlı + deterministik); izolasyon `--config` tmp dosyasıyla, repo
 * kökü enjeksiyonuyla (`deps.root`). Tek bilinçli istisna yok.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MCP_KEY,
  SetupError,
  applyPlan,
  applySymlinkCleanup,
  checkRepo,
  computePlan,
  discoveryDirFor,
  isMcpDisabled,
  loadConfig,
  packageDirFor,
  parseArgs,
  planSymlinkCleanup,
  readMcpEntry,
  repoRoot,
  run,
} from "../scripts/setup.mjs"

const ROOT = repoRoot()

function collector() {
  const lines = []
  return { lines, log: (m) => lines.push(m), err: (m) => lines.push(m) }
}

function tmpCfg() {
  const dir = mkdtempSync(join(tmpdir(), "setup-test-"))
  return { dir, path: join(dir, "opencode.jsonc") }
}

test("checkRepo: repo kökü temiz (dist derli)", () => {
  assert.ok(existsSync(join(ROOT, "dist", "plugins", "server.js")), "önce npm run build")
  const r = checkRepo(ROOT)
  assert.equal(r.ok, true)
  assert.deepEqual(r.missing, [])
})

test("checkRepo: boş dizinde eksikleri listeler", () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-empty-"))
  try {
    const r = checkRepo(dir)
    assert.equal(r.ok, false)
    assert.ok(r.missing.includes("dist/plugins/server.js"))
    assert.ok(r.missing.includes("dist/plugins/mcp-bash-tools/src/server.js"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("computePlan: boş config'e mcp.servers.nabiz + paket dizini ekler (V2 şekli)", () => {
  const { changes, next, dirty } = computePlan({}, ROOT)
  assert.equal(dirty, true)
  const entry = next.mcp.servers[MCP_KEY]
  assert.equal(entry.type, "local")
  assert.deepEqual(entry.command, ["node", join(ROOT, "dist", "plugins", "mcp-bash-tools", "src", "server.js")])
  assert.ok(!("enabled" in entry), "V1 enabled alanı yazılmaz")
  assert.ok(!("disabled" in entry), "açık sunucuda disabled yazılmaz (fail-open)")
  assert.ok(!(MCP_KEY in next.mcp), "düz V1 girişi yazılmaz (sunucu onu okumaz)")
  assert.deepEqual(next.plugins, [packageDirFor(ROOT)], "tek paket girdisi")
  assert.ok(!("plugin" in next), "V1 anahtarı yazılmaz")
  assert.equal(changes.length, 2)
})

test("computePlan: repo'ya ait stale dosya girdileri temizlenir (V1 plugin + V2 plugins)", () => {
  const owned0 = join(ROOT, "plugins", "opencode-context-saver.ts")
  const owned1 = join(ROOT, "plugins", "opencode-hbmon.ts")
  const cfg = {
    mcp: {
      servers: {
        [MCP_KEY]: {
          type: "local",
          command: ["node", join(ROOT, "dist", "plugins", "mcp-bash-tools", "src", "server.js")],
        },
      },
    },
    plugin: [owned0, "/x/baskasinin.ts"],
    plugins: [owned1, { package: owned0, options: {} }, "/y/baskasinin.ts"],
  }
  const { next, dirty } = computePlan(cfg, ROOT)
  assert.equal(dirty, true)
  // Bizimkiler gitti, başkasınınkiler duruyor + paket dizini eklendi.
  assert.deepEqual(next.plugin, ["/x/baskasinin.ts"])
  assert.deepEqual(next.plugins, ["/y/baskasinin.ts", packageDirFor(ROOT)])
  // mcp zaten günceldi → sadece temizlik değişiklikleri.
  assert.ok(next.mcp.servers[MCP_KEY].command[1].replaceAll("\\", "/").endsWith("mcp-bash-tools/src/server.js"))
})

test("computePlan: mcp.bash (bizim dist) → mcp.servers.nabiz taşınır, kapatma tercihi korunur", () => {
  const cfg = {
    mcp: {
      bash: {
        type: "local",
        command: ["node", join(ROOT, "dist", "plugins", "mcp-bash-tools", "src", "server.js")],
        enabled: false,
      },
    },
  }
  const { next, dirty } = computePlan(cfg, ROOT)
  assert.equal(dirty, true)
  assert.ok(!("bash" in next.mcp), "eski key gider")
  const entry = next.mcp.servers[MCP_KEY]
  assert.equal(entry.type, "local")
  assert.ok(entry.command[1].replaceAll("\\", "/").endsWith("mcp-bash-tools/src/server.js"))
  assert.equal(entry.disabled, true, "V1 enabled:false → V2 disabled:true")
})

test("computePlan: V1 düz mcp.nabiz girdisi iç içe normalleştirilir (idempotans)", () => {
  const cmd = ["node", join(ROOT, "dist", "plugins", "mcp-bash-tools", "src", "server.js")]
  const cfg = { mcp: { [MCP_KEY]: { type: "local", command: cmd, enabled: true } } }
  const first = computePlan(cfg, ROOT)
  assert.equal(first.dirty, true)
  assert.ok(
    first.changes.some((c) => c.includes("V1 düz")),
    "normalleştirme bildirilir",
  )
  assert.ok(!(MCP_KEY in first.next.mcp), "düz giriş silinir")
  assert.deepEqual(first.next.mcp.servers[MCP_KEY], { type: "local", command: cmd })
  // İkinci pass temiz: uygulanmış plan idempotent.
  const second = computePlan(first.next, ROOT)
  assert.equal(second.dirty, false, `ikinci pass kirli: ${JSON.stringify(second.changes)}`)
})

test("readMcpEntry/isMcpDisabled: iki şekil + iki kapatma bayrağı (NABIZ-012)", () => {
  assert.deepEqual(readMcpEntry({}, MCP_KEY), { found: false, entry: undefined, shape: null })
  const v2 = { mcp: { servers: { [MCP_KEY]: { type: "local" } } } }
  assert.equal(readMcpEntry(v2, MCP_KEY).shape, "v2")
  assert.equal(readMcpEntry({ mcp: { [MCP_KEY]: { type: "local" } } }, MCP_KEY).shape, "v1")
  // İç içe kazanır (V2 hedef).
  assert.equal(readMcpEntry({ mcp: { [MCP_KEY]: { a: 1 }, servers: { [MCP_KEY]: { b: 2 } } } }, MCP_KEY).shape, "v2")
  assert.equal(isMcpDisabled({ disabled: true }), true)
  assert.equal(isMcpDisabled({ enabled: false }), true, "V1 bayrağı da kapatma sayılır")
  assert.equal(isMcpDisabled({ enabled: true }), false)
  assert.equal(isMcpDisabled(undefined), false)
})

test("computePlan: başkasının mcp.bash girdisine dokunmaz", () => {
  const cfg = {
    mcp: { bash: { type: "local", command: ["something-else"], enabled: true } },
  }
  const { next } = computePlan(cfg, ROOT)
  assert.deepEqual(next.mcp.bash, cfg.mcp.bash, "yabancı girdi korunur")
  assert.ok(next.mcp.servers[MCP_KEY], "nabiz iç içe eklenir")
})

test("computePlan: başkasına ait girdilere + pluginOptions'a dokunmaz", () => {
  const cfg = {
    mcp: { codegraph: { type: "local", command: ["x"], enabled: true } },
    plugin: ["/x/baskasinin.ts"],
    pluginOptions: { "my-opt": 1 },
  }
  const { next } = computePlan(cfg, ROOT)
  assert.deepEqual(next.mcp.codegraph, cfg.mcp.codegraph)
  assert.deepEqual(next.pluginOptions, cfg.pluginOptions)
  assert.deepEqual(next.plugin, ["/x/baskasinin.ts"], "yabancı V1 girdisi korunur")
  assert.ok(next.mcp.servers[MCP_KEY])
})

test("computePlan: kullanıcı anahtarlarına dokunmaz", () => {
  const cfg = {
    mcp: { codegraph: { type: "local", command: ["x"], enabled: true } },
    pluginOptions: { "my-opt": 1 },
  }
  const { next } = computePlan(cfg, ROOT)
  assert.deepEqual(next.mcp.codegraph, cfg.mcp.codegraph)
  assert.deepEqual(next.pluginOptions, cfg.pluginOptions)
  assert.ok(next.mcp.servers[MCP_KEY])
})

test("computePlan: idempotent (uygulanmış plana ikinci pass temiz)", () => {
  const first = computePlan({}, ROOT)
  const second = computePlan(first.next, ROOT)
  assert.equal(second.dirty, false)
  assert.deepEqual(second.changes, [])
})

test("discoveryDirFor: config yanındaki plugins/ klasörü", () => {
  const cfg = join("a", "b", "opencode.jsonc")
  assert.equal(discoveryDirFor(cfg), join("a", "b", "plugins"))
})

test("packageDirFor: repo plugin/ dizini", () => {
  assert.equal(packageDirFor(ROOT), join(ROOT, "plugin"))
})

test("planSymlinkCleanup: repo hedefli symlink'leri bulur, yabancı/normal dosyaya dokunmaz", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "links-"))
  try {
    const cfg = join(dir, "opencode.jsonc")
    const ddir = discoveryDirFor(cfg)
    mkdirSync(ddir, { recursive: true })
    // Bizim symlink → listelenir.
    try {
      symlinkSync(join(ROOT, "plugins", "opencode-hbmon.ts"), join(ddir, "opencode-hbmon.ts"))
    } catch (e) {
      // Windows'ta symlink yetkisi yoksa (EPERM, Developer Mode kapalı) atla.
      if (e?.code === "EPERM" || e?.code === "EACCES") return t.skip("symlink yetkisi yok (Windows EPERM)")
      throw e
    }
    // Yabancı symlink → yok sayılır (hedefi de gerçek dosya).
    writeFileSync(join(dir, "yabanci-hedef.ts"), "// yabancı")
    symlinkSync(join(dir, "yabanci-hedef.ts"), join(ddir, "opencode-context-saver.ts"))
    // Normal dosya → yok sayılır.
    writeFileSync(join(ddir, "opencode-build-tracker.ts"), "benim dosyam")
    const plans = planSymlinkCleanup(ROOT, cfg)
    assert.equal(plans.length, 1)
    assert.ok(plans[0].link.endsWith("opencode-hbmon.ts"))
    const removed = applySymlinkCleanup(plans)
    assert.equal(removed.length, 1)
    assert.ok(!existsSync(join(ddir, "opencode-hbmon.ts")))
    // Yabancı + normal dosya duruyor.
    assert.ok(existsSync(join(ddir, "opencode-context-saver.ts")))
    assert.equal(readFileSync(join(ddir, "opencode-build-tracker.ts"), "utf8"), "benim dosyam")
    assert.deepEqual(planSymlinkCleanup(ROOT, cfg), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run: bayraksız → plan + exit 2, dosya yazılmaz", async () => {
  const { dir, path } = tmpCfg()
  try {
    const c = collector()
    const code = await run([], { root: ROOT, configPath: path, ...c })
    assert.equal(code, 2)
    assert.ok(!existsSync(path), "yazılmamalı")
    assert.ok(c.lines.some((l) => l.includes("--yes")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run: --dry-run önizler, yazmaz, exit 0", async () => {
  const { dir, path } = tmpCfg()
  try {
    const c = collector()
    const code = await run(["--dry-run"], { root: ROOT, configPath: path, ...c })
    assert.equal(code, 0)
    assert.ok(!existsSync(path))
    assert.ok(c.lines.some((l) => l.includes(`mcp.servers.${MCP_KEY}`)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run: --check kirliyken exit 1, --yes sonrası exit 0", async () => {
  const { dir, path } = tmpCfg()
  try {
    const c = collector()
    assert.equal(await run(["--check"], { root: ROOT, configPath: path, ...c }), 1)
    assert.equal(await run(["--yes"], { root: ROOT, configPath: path, ...c }), 0)
    const written = JSON.parse(readFileSync(path, "utf8"))
    assert.ok(written.mcp.servers[MCP_KEY])
    assert.deepEqual(written.plugins, [packageDirFor(ROOT)], "paket dizini tek girdi")
    assert.equal(await run(["--check"], { root: ROOT, configPath: path, ...c }), 0)
    assert.equal(await run(["--yes"], { root: ROOT, configPath: path, ...c }), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run: --yes yedek alır, kullanıcı girdisini korur", async () => {
  const { dir, path } = tmpCfg()
  try {
    writeFileSync(path, JSON.stringify({ mcp: { other: { a: 1 } }, plugins: [] }))
    const c = collector()
    assert.equal(await run(["--yes"], { root: ROOT, configPath: path, ...c }), 0)
    const written = JSON.parse(readFileSync(path, "utf8"))
    assert.deepEqual(written.mcp.other, { a: 1 })
    assert.ok(c.lines.some((l) => l.startsWith("yedek: ")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run: bozuk config fail-loud (exit 1, yazmaz)", async () => {
  const { dir, path } = tmpCfg()
  try {
    writeFileSync(path, "{ // yorumlu jsonc\n}")
    const before = readFileSync(path, "utf8")
    const c = collector()
    assert.equal(await run(["--yes"], { root: ROOT, configPath: path, ...c }), 1)
    assert.equal(readFileSync(path, "utf8"), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run: eksik dist fail-loud (exit 1)", async () => {
  const { dir, path } = tmpCfg()
  const empty = mkdtempSync(join(tmpdir(), "setup-nodist-"))
  try {
    const c = collector()
    const code = await run(["--yes"], { root: empty, configPath: path, ...c })
    assert.equal(code, 1)
    assert.ok(c.lines.some((l) => l.includes("npm run build")))
    assert.ok(!existsSync(path))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

test("parseArgs: çift mod + bilinmeyen arg hatası", () => {
  assert.throws(() => parseArgs(["--yes", "--dry-run"]), SetupError)
  assert.throws(() => parseArgs(["--bogus"]), SetupError)
  assert.deepEqual(parseArgs(["--config", "x.json"]).config.endsWith("x.json"), true)
})

test("applyPlan: yazar + yedek döner", () => {
  const { dir, path } = tmpCfg()
  try {
    writeFileSync(path, "{}")
    const backup = applyPlan(path, { a: 1 })
    assert.ok(backup && existsSync(backup))
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { a: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadConfig: yoksa boş, bozuksa throw", () => {
  const { dir, path } = tmpCfg()
  try {
    assert.deepEqual(loadConfig(join(dir, "yok.jsonc")), { exists: false, config: {} })
    writeFileSync(path, "bozuk{")
    assert.throws(() => loadConfig(path), SetupError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
