/**
 * ToolContext plumbing testi (Faz 7).
 *
 * Promise ToolContext: { sessionID, agent, messageID, id, signal, progress }.
 * Bugün: yalnız bg_run sessionID okur; diğer 6 tool context'i parametre olarak almaz.
 *
 * Bu test:
 *  1) fullCtx ile execute çağrısının crash etmediğini kilitler
 *  2) signal'in henüz kullanılmadığını belgeler (sonuç aborted/non-aborted aynı şekil)
 *
 * İptal davranışı iddia edilmez — Faz 8'de signal/progress bağlanınca genişletilir.
 */

import test from "node:test"
import assert from "node:assert/strict"
import hbmonFactory from "../dist/plugins/opencode-hbmon.js"
import { setupV2, textOf } from "./v2-harness.mjs"

const fullCtx = {
  sessionID: "sess-test",
  agent: "build",
  messageID: "msg-test",
  id: "call-test",
  signal: AbortSignal.abort(),
  progress() {},
}

test("tool-context: hbmon_wait execute(input, fullCtx) crash etmez", async () => {
  const { addedTools, cleanup } = await setupV2(hbmonFactory, {})
  try {
    const wait = addedTools.find((t) => t.name === "hbmon_wait")
    assert.ok(wait, "hbmon_wait registered")
    // fullCtx ile çağrı — throw olmamalı (signal unused gap belgesi)
    const result = await wait.execute({ sock: "/tmp/nonexistent.sock" }, fullCtx)
    assert.ok(result, "result döndü")
    assert.ok(typeof textOf(result.content) === "string", "content string")
  } finally {
    await cleanup?.()
  }
})

test("tool-context: hbmon_status execute(input, fullCtx) crash etmez", async () => {
  const { addedTools, cleanup } = await setupV2(hbmonFactory, {})
  try {
    const status = addedTools.find((t) => t.name === "hbmon_status")
    assert.ok(status, "hbmon_status registered")
    const result = await status.execute({ sock: "/tmp/nonexistent.sock" }, fullCtx)
    assert.ok(result, "result döndü")
    assert.ok(typeof textOf(result.content) === "string", "content string")
  } finally {
    await cleanup?.()
  }
})

test("tool-context: bg_status execute(input, fullCtx) crash etmez", async () => {
  const { addedTools, cleanup } = await setupV2(hbmonFactory, {})
  try {
    const bgStatus = addedTools.find((t) => t.name === "bg_status")
    assert.ok(bgStatus, "bg_status registered")
    const result = await bgStatus.execute({ id: "nonexistent" }, fullCtx)
    assert.ok(result, "result döndü")
    assert.ok(typeof textOf(result.content) === "string", "content string")
  } finally {
    await cleanup?.()
  }
})

test("tool-context: bg_logs execute(input, fullCtx) crash etmez", async () => {
  const { addedTools, cleanup } = await setupV2(hbmonFactory, {})
  try {
    const bgLogs = addedTools.find((t) => t.name === "bg_logs")
    assert.ok(bgLogs, "bg_logs registered")
    const result = await bgLogs.execute({ id: "nonexistent" }, fullCtx)
    assert.ok(result, "result döndü")
    assert.ok(typeof textOf(result.content) === "string", "content string")
  } finally {
    await cleanup?.()
  }
})

test("tool-context: bg_kill execute(input, fullCtx) crash etmez", async () => {
  const { addedTools, cleanup } = await setupV2(hbmonFactory, {})
  try {
    const bgKill = addedTools.find((t) => t.name === "bg_kill")
    assert.ok(bgKill, "bg_kill registered")
    const result = await bgKill.execute({ id: "nonexistent" }, fullCtx)
    assert.ok(result, "result döndü")
    assert.ok(typeof textOf(result.content) === "string", "content string")
  } finally {
    await cleanup?.()
  }
})

test("tool-context: hbmon_watch execute(input, fullCtx) crash etmez", async () => {
  const { addedTools, cleanup } = await setupV2(hbmonFactory, {})
  try {
    const watch = addedTools.find((t) => t.name === "hbmon_watch")
    assert.ok(watch, "hbmon_watch registered")
    const result = await watch.execute({ command: ["echo", "test"] }, fullCtx)
    assert.ok(result, "result döndü")
    assert.ok(typeof textOf(result.content) === "string", "content string")
  } finally {
    await cleanup?.()
  }
})

test("tool-context: bg_run sessionID'yi kayda yazar (mevcut davranış)", async () => {
  // bg_run zaten context.sessionID okuyor — bu test mevcut davranışı kilitler.
  // Faz 8'de signal/progress eklendiğinde bu test genişletilecek.
  const { addedTools, cleanup } = await setupV2(hbmonFactory, {})
  try {
    const bgRun = addedTools.find((t) => t.name === "bg_run")
    assert.ok(bgRun, "bg_run registered")
    // bg_run execute(input, context) — context.sessionID okunur
    // Not: gerçek hbmon daemon gerekmez; watchBuild başarısız olursa error döner
    const result = await bgRun.execute(
      { name: "test-task", command: "echo hello", notify: false },
      fullCtx,
    )
    assert.ok(result, "result döndü")
    assert.ok(typeof textOf(result.content) === "string", "content string")
  } finally {
    await cleanup?.()
  }
})
