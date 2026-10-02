// scripts/check-dist.mjs — nabiz-core dist tazelik kontrolü (NABIZ-013).
//
// V2 plugin `.ts` kaynaktan yüklenir ama `nabiz-core` import'ları paket
// `exports` üzerinden `dist/`'e çözülür. `src` değişip `dist` derlenmezse
// host "failed to load plugin" verir (MCP ayrı yoldan geldiği için
// "her şey çalışıyor" izlenimi sürer).
// Kaynak yoksa (paketli kurulum) karar verilemez → sessiz geçilir;
// `src` varken `dist` yoksa ya da eskiyse exit 1.
//
// Kullanım: node scripts/check-dist.mjs [--src D] [--dist D]

import { readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

function newestMtime(dir, ext) {
  let newest = 0
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      return -1
    }
    for (const e of entries) {
      const p = join(cur, e.name)
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue
        stack.push(p)
      } else if (e.name.endsWith(ext)) {
        const ms = statSync(p).mtimeMs
        if (ms > newest) newest = ms
      }
    }
  }
  return newest
}

export function checkDist(srcDir, distDir) {
  const src = newestMtime(srcDir, ".ts")
  if (src < 0) return { ok: true, skipped: true, reason: `kaynak yok (paketli kurulum?): ${srcDir}` }
  if (src === 0) return { ok: true, skipped: true, reason: `izlenecek .ts yok: ${srcDir}` }
  const dist = newestMtime(distDir, ".js")
  if (dist <= 0)
    return { ok: false, srcNewest: src, distNewest: 0, reason: `derli yok: ${distDir} — önce çalıştır: npm run build` }
  if (src > dist)
    return {
      ok: false,
      srcNewest: src,
      distNewest: dist,
      reason: `bayat derli: ${srcDir} ${distDir}'ten yeni — önce çalıştır: npm run build`,
    }
  return { ok: true, srcNewest: src, distNewest: dist }
}

function argPath(flag, fallback) {
  const i = process.argv.indexOf(flag)
  if (i < 0 || !process.argv[i + 1]) return fallback
  return resolve(process.cwd(), process.argv[i + 1])
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const pkg = dirname(dirname(fileURLToPath(import.meta.url)))
  const srcDir = argPath("--src", join(pkg, "..", "core", "src"))
  const distDir = argPath("--dist", join(pkg, "..", "core", "dist"))
  const r = checkDist(srcDir, distDir)
  if (r.ok && !r.skipped) console.log(`taze: dist src ile aynı ya da daha yeni`)
  if (r.ok && r.skipped) console.log(`geçildi: ${r.reason}`)
  if (!r.ok) {
    console.error(`hata: ${r.reason}`)
    process.exit(1)
  }
}
