/**
 * V2 plugin test harness (`@opencode/plugin` 2.x).
 *
 * V1'de plugin factory doğrudan çağrılıp dönen hooks objesindeki
 * `plugin["tool.execute.after"](input, output)` imzası kullanılıyordu.
 * V2'de plugin `Plugin.define({ id, setup })` objesidir; hook'lar
 * `setup(ctx)` içinde `ctx.session.hook / ctx.tool.hook /
 * ctx.event.subscribe / ctx.tool.transform` üzerinden kaydolur ve
 * callback'ler TEK mutable event objesi alır.
 *
 * Bu harness sahte `ctx` kurar, kaydolunan hook'ları toplar ve
 * V1-test stilli çağrılara (`toolAfter(...)` vb.) dönüştürür.
 */

export function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p != null && typeof p === "object" && "text" in p) return String(p.text ?? "")
        try {
          return JSON.stringify(p)
        } catch {
          return String(p)
        }
      })
      .join("\n")
  }
  if (content == null) return ""
  if (typeof content === "object") {
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return String(content)
}

export async function setupV2(def, options = {}) {
  const store = new Map()
  // V2 gerçeği: aynı hook'a birden çok kayıt OLABİLİR (bundle!), hepsi
  // kayıt sırasında koşar. O yüzden dizi tutulur, ezilmez.
  const sessionHooks = {}
  const toolHooks = {}
  const addedTools = []
  const queue = []
  const waiters = []

  const pushEvent = (e) => {
    if (waiters.length > 0) waiters.shift()(e)
    else queue.push(e)
  }

  async function* subscribe({ signal } = {}) {
    for (;;) {
      if (signal?.aborted) return
      if (queue.length > 0) {
        yield queue.shift()
        continue
      }
      const next = await new Promise((resolve) => {
        if (signal?.aborted) return resolve(null)
        const onAbort = () => resolve(null)
        signal?.addEventListener("abort", onAbort, { once: true })
        waiters.push((v) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(v)
        })
      })
      if (next === null || signal?.aborted) return
      yield next
    }
  }

  const ctx = {
    options,
    location: { directory: "/tmp", project: { id: "test-project" } },
    app: { name: "test", version: "2.0.16", channel: "test" },
    session: {
      hook: async (name, cb) => {
        ;(sessionHooks[name] ??= []).push(cb)
        return { dispose: async () => { sessionHooks[name] = (sessionHooks[name] ?? []).filter((f) => f !== cb) } }
      },
      prompt: async () => ({}),
      synthetic: async () => ({}),
      generate: async () => ({ text: "" }),
      create: async () => ({}),
      get: async () => ({}),
      context: async () => [],
    },
    tool: {
      hook: async (name, cb) => {
        ;(toolHooks[name] ??= []).push(cb)
        return { dispose: async () => { toolHooks[name] = (toolHooks[name] ?? []).filter((f) => f !== cb) } }
      },
      transform: async (cb) => {
        const editor = {
          list: () => [],
          get: () => undefined,
          namespace: () => {},
          add: (d) => { addedTools.push(d) },
          update: () => {},
          remove: () => {},
        }
        cb(editor)
        return { dispose: async () => {} }
      },
      list: async () => [],
      reload: async () => {},
    },
    event: { subscribe },
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => { store.set(k, v) },
      remove: async (k) => { store.delete(k) },
      scan: async ({ prefix }) => ({
        entries: [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      }),
    },
  }
  const cleanup = await def.setup(ctx)
  return { ctx, sessionHooks, toolHooks, addedTools, pushEvent, store, cleanup }
}

/** V2 `execute.before` event'i kur + TÜM kayıtlı hook'ları sırayla çalıştır. */
export async function toolBefore(
  toolHooks,
  { tool = "bash", sessionID = "s", id = "c1", input = {} } = {},
) {
  const e = { tool, sessionID, agent: "a", messageID: "m", id, input }
  for (const cb of toolHooks["execute.before"] ?? []) await cb(e)
  return e
}

/**
 * V2 `execute.after` event'i kur + TÜM kayıtlı hook'ları sırayla çalıştır;
 * sonuç metnini döndür. V1'deki `{ output }` → V2'de `result: { content }`.
 */
export async function toolAfter(
  toolHooks,
  { tool = "bash", sessionID = "s", id = "c1", input = {}, output = "" } = {},
) {
  const e = {
    tool,
    sessionID,
    agent: "a",
    messageID: "m",
    id,
    input,
    status: "completed",
    result: { content: output },
  }
  for (const cb of toolHooks["execute.after"] ?? []) await cb(e)
  return textOf(e.result.content)
}

/** V2 `session.hook("context")` event'i kur + TÜM kayıtlı hook'ları çalıştır. */
export async function sessionContext(sessionHooks, system = []) {
  const e = {
    sessionID: "s",
    agent: "a",
    model: { providerID: "p", id: "m" },
    system: system.map((t) => (typeof t === "string" ? { type: "text", text: t } : t)),
    messages: [],
    tools: {},
    options: {},
  }
  for (const cb of sessionHooks["context"] ?? []) await cb(e)
  return e
}

/** V2 `session.hook("prompt")` event'i kur + TÜM kayıtlı hook'ları çalıştır. */
export async function sessionPrompt(sessionHooks, text = "hi") {
  const e = {
    sessionID: "s",
    messageID: "m",
    prompt: { text, files: [] },
    metadata: {},
    delivery: "steer",
  }
  for (const cb of sessionHooks["prompt"] ?? []) await cb(e)
  return e
}

/** Bir hook adına en az bir kayıt var mı? */
export function hasHook(hooks, name) {
  return Array.isArray(hooks[name]) && hooks[name].length > 0
}

/** system parçalarından düz metinler (string + {text} karışık). */
export function systemTexts(system) {
  return system.map((s) => (typeof s === "string" ? s : (s?.text ?? "")))
}

export const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))
