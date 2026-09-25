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
  loadConfig,
  packageDirFor,
  parseArgs,
  planSymlinkCleanup,
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

test("computePlan: boş config'e mcp.nabiz + paket dizini ekler", () => {
  const { changes, next, dirty } = computePlan({}, ROOT)
  assert.equal(dirty, true)
  assert.equal(next.mcp[MCP_KEY].type, "local")
  assert.deepEqual(next.mcp[MCP_KEY].command, [
    "node",
    join(ROOT, "dist", "plugins", "mcp-bash-tools", "src", "server.js"),
  ])
  assert.equal(next.mcp[MCP_KEY].enabled, true)
  assert.deepEqual(next.plugins, [packageDirFor(ROOT)], "tek paket girdisi")
  assert.ok(!("plugin" in next), "V1 anahtarı yazılmaz")
  assert.equal(changes.length, 2)
})

test("computePlan: repo'ya ait stale dosya girdileri temizlenir (V1 plugin + V2 plugins)", () => {
  const owned0 = join(ROOT, "plugins", "opencode-context-saver.ts")
  const owned1 = join(ROOT, "plugins", "opencode-hbmon.ts")
  const cfg = {
    mcp: { [MCP_KEY]: { type: "local", command: ["node", join(ROOT, "dist", "plugins", "mcp-bash-tools", "src", "server.js")], enabled: true } },
    plugin: [owned0, "/x/baskasinin.ts"],
    plugins: [owned1, { package: owned0, options: {} }, "/y/baskasinin.ts"],
  }
  const { next, dirty } = computePlan(cfg, ROOT)
  assert.equal(dirty, true)
  // Bizimkiler gitti, başkasınınkiler duruyor + paket dizini eklendi.
  assert.deepEqual(next.plugin, ["/x/baskasinin.ts"])
  assert.deepEqual(next.plugins, ["/y/baskasinin.ts", packageDirFor(ROOT)])
  // mcp zaten günceldi → sadece temizlik değişiklikleri.
  assert.ok(
    next.mcp[MCP_KEY].command[1].endsWith("mcp-bash-tools/src/server.js"),
  )
})

test("computePlan: mcp.bash (bizim dist) → mcp.nabiz taşınır, enabled korunur", () => {
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
  assert.equal(next.mcp[MCP_KEY].type, "local")
  assert.ok(next.mcp[MCP_KEY].command[1].endsWith("mcp-bash-tools/src/server.js"))
  assert.equal(next.mcp[MCP_KEY].enabled, false, "kullanıcı bayrağı korunur")
})

test("computePlan: başkasının mcp.bash girdisine dokunmaz", () => {
  const cfg = {
    mcp: { bash: { type: "local", command: ["something-else"], enabled: true } },
  }
  const { next } = computePlan(cfg, ROOT)
  assert.deepEqual(next.mcp.bash, cfg.mcp.bash, "yabancı girdi korunur")
  assert.ok(next.mcp[MCP_KEY], "nabiz ayrıca eklenir")
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
  assert.ok(next.mcp[MCP_KEY])
})

test("computePlan: kullanıcı anahtarlarına dokunmaz", () => {
  const cfg = {
    mcp: { codegraph: { type: "local", command: ["x"], enabled: true } },
    pluginOptions: { "my-opt": 1 },
  }
  const { next } = computePlan(cfg, ROOT)
  assert.deepEqual(next.mcp.codegraph, cfg.mcp.codegraph)
  assert.deepEqual(next.pluginOptions, cfg.pluginOptions)
  assert.ok(next.mcp[MCP_KEY])
})

test("computePlan: idempotent (uygulanmış plana ikinci pass temiz)", () => {
  const first = computePlan({}, ROOT)
  const second = computePlan(first.next, ROOT)
  assert.equal(second.dirty, false)
  assert.deepEqual(second.changes, [])
})

test("discoveryDirFor: config yanındaki plugins/ klasörü", () => {
  assert.equal(discoveryDirFor("/a/b/opencode.jsonc"), "/a/b/plugins")
})

test("packageDirFor: repo plugin/ dizini", () => {
  assert.equal(packageDirFor(ROOT), join(ROOT, "plugin"))
})

test("planSymlinkCleanup: repo hedefli symlink'leri bulur, yabancı/normal dosyaya dokunmaz", () => {
  const dir = mkdtempSync(join(tmpdir(), "links-"))
  try {
    const cfg = join(dir, "opencode.jsonc")
    const ddir = discoveryDirFor(cfg)
    mkdirSync(ddir, { recursive: true })
    // Bizim symlink → listelenir.
    symlinkSync(join(ROOT, "plugins", "opencode-hbmon.ts"), join(ddir, "opencode-hbmon.ts"))
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
    assert.ok(c.lines.some((l) => l.includes(`mcp.${MCP_KEY}`)))
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
    assert.ok(written.mcp[MCP_KEY])
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
