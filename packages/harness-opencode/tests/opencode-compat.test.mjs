/**
 * Tests for plugins/lib/opencode-compat.ts (host varsayım tamponu).
 *
 * Kilitlenen: host kurallarının bu modüldeki karşılığı — ad biçimi,
 * segment bazlı namespace, rezerve ad, izin sözlüğü. Kural kayarsa
 * test değil, önce modül güncellenir (tek kaynak).
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  CompatError,
  HOOK_SESSION_CONTEXT,
  HOOK_SESSION_PROMPT,
  HOOK_TOOL_AFTER,
  HOOK_TOOL_BEFORE,
  NAMESPACE_SEGMENT_RE,
  RESERVED_TOOL_NAMES,
  TOOL_NAME_RE,
  adaptPermissionWord,
  adaptToolInfo,
  assertValidNamespace,
  assertValidToolName,
} from "../dist/plugins/lib/opencode-compat.js"

test("compat: tool adı kuralı host ile aynı", () => {
  assert.ok(TOOL_NAME_RE.test("hbmon_watch"))
  assert.ok(TOOL_NAME_RE.test("bg_run"))
  assert.ok(!TOOL_NAME_RE.test("build pulse"))
  assert.ok(!TOOL_NAME_RE.test("x".repeat(129)))
  assert.ok(RESERVED_TOOL_NAMES.has("execute"))
})

test("compat: namespace segment kuralı (nokta ayırıcı)", () => {
  assert.ok("nabiz".split(".").every((s) => NAMESPACE_SEGMENT_RE.test(s)))
  assert.ok("a.b".split(".").every((s) => NAMESPACE_SEGMENT_RE.test(s)))
  assert.ok(!"build pulse".split(".").every((s) => NAMESPACE_SEGMENT_RE.test(s)))
  assert.ok(
    !"x"
      .repeat(65)
      .split(".")
      .every((s) => NAMESPACE_SEGMENT_RE.test(s)),
  )
})

test("compat: kanca adları host spec'indeki adlar", () => {
  assert.equal(HOOK_SESSION_CONTEXT, "context")
  assert.equal(HOOK_SESSION_PROMPT, "prompt")
  assert.equal(HOOK_TOOL_BEFORE, "execute.before")
  assert.equal(HOOK_TOOL_AFTER, "execute.after")
})

test("compat: assertValidToolName bozuk adı yüksek sesle reddeder", () => {
  assert.throws(() => assertValidToolName("build pulse"), CompatError)
  assert.throws(() => assertValidToolName("execute"), CompatError)
  assert.throws(() => assertValidToolName("x".repeat(129)), CompatError)
  assert.doesNotThrow(() => assertValidToolName("hbmon_watch"))
})

test("compat: assertValidNamespace sessiz-düşme girdilerini yakalar", () => {
  assert.doesNotThrow(() => assertValidNamespace("nabiz"))
  assert.doesNotThrow(() => assertValidNamespace("a.b"))
  assert.throws(() => assertValidNamespace("build pulse"), CompatError)
  assert.throws(() => assertValidNamespace("a..b"), CompatError)
  assert.throws(() => assertValidNamespace("x".repeat(65)), CompatError)
  assert.throws(() => assertValidNamespace(""), CompatError)
})

test("compat: adaptPermissionWord V1 sözcüğü V2'ye çevirir", () => {
  assert.equal(adaptPermissionWord("task"), "subagent")
  assert.equal(adaptPermissionWord("bash"), "execute")
  assert.equal(adaptPermissionWord("read"), "read")
})

test("compat: adaptToolInfo geçerli girdiyi aynen geçirir", () => {
  const info = { name: "hbmon_watch", options: { namespace: "nabiz" } }
  assert.equal(adaptToolInfo(info), info)
})

test("compat: adaptToolInfo bozuk girdide CompatError atar", () => {
  assert.throws(() => adaptToolInfo({ name: "kötü ad", options: {} }), CompatError)
  assert.throws(() => adaptToolInfo({ name: "ok_ad", options: { namespace: "kötü ns" } }), CompatError)
  assert.throws(() => adaptToolInfo({ name: "execute", options: {} }), CompatError)
})

test("compat: adaptToolInfo eski izin sözcüğünü normalleştirir", () => {
  const out = adaptToolInfo({ name: "x", options: { permission: "task" } })
  assert.equal(out.options.permission, "subagent")
})
