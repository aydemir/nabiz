/**
 * Tests for scripts/check-dist.mjs (NABIZ-013).
 *
 * Strateji: tmp dizinlerde .ts/.js + utimesSync ile mtime kaydırılır;
 * gerçek repo'ya dokunulmaz. Bayat = src dist'ten yeni (ya da dist yok).
 */

import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkDist } from "../scripts/check-dist.mjs"

function layout() {
  const dir = mkdtempSync(join(tmpdir(), "check-dist-"))
  const src = join(dir, "src")
  const dist = join(dir, "dist")
  mkdirSync(src, { recursive: true })
  mkdirSync(dist, { recursive: true })
  return { dir, src, dist }
}

function touch(path, epochMs) {
  writeFileSync(path, "export const x = 1\n")
  const d = new Date(epochMs)
  utimesSync(path, d, d)
}

test("checkDist: dist yeniyse taze", () => {
  const { dir, src, dist } = layout()
  try {
    touch(join(src, "a.ts"), 1000000000000)
    touch(join(dist, "a.js"), 1000000001000)
    const r = checkDist(src, dist)
    assert.equal(r.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("checkDist: src yeniyse bayat (NABIZ-013 kilidi)", () => {
  const { dir, src, dist } = layout()
  try {
    touch(join(src, "a.ts"), 1000000001000)
    touch(join(dist, "a.js"), 1000000000000)
    const r = checkDist(src, dist)
    assert.equal(r.ok, false)
    assert.match(r.reason, /bayat derli/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("checkDist: dist yoksa bayat", () => {
  const { dir, src } = layout()
  try {
    touch(join(src, "a.ts"), 1000000000000)
    const r = checkDist(src, join(dir, "yok"))
    assert.equal(r.ok, false)
    assert.match(r.reason, /derli yok/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("checkDist: kaynak yoksa sessiz geç (paketli kurulum)", () => {
  const { dir, dist } = layout()
  try {
    touch(join(dist, "a.js"), 1000000000000)
    const r = checkDist(join(dir, "yok-src"), dist)
    assert.equal(r.ok, true)
    assert.equal(r.skipped, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
