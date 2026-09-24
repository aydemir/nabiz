/**
 * bash (eski ad: opencode-mcp-bash-tools) — stdio MCP server
 *
 * İki tool sunar (server-içi adlar; opencode TUI'de `<config-key>_<tool>`
 * olarak görünür — config key `bash` olunca TUI adları `bash_safe` /
 * `bash_raw` olur):
 *   - safe: middle-prune + marker (default; TUI: bash_safe).
 *   - raw:  full output (no prune; TUI: bash_raw).
 *
 * MCP protokolü: JSON-RPC 2.0, line-delimited, stdin/stdout.
 * opencode MCP standardı.
 */

import { bashSafeHandler, bashSafeSchema } from "./tools/bash_safe.js"
import { bashRawHandler, bashRawSchema } from "./tools/bash_raw.js"
import * as fs from "node:fs"

const SERVER_INFO = {
  name: "bash",
  version: "0.1.0",
}

const PROTOCOL_VERSION = "2024-11-05"

const TOOLS = [
  {
    name: "safe",
    description:
      "Execute a bash command and return its output. If output exceeds " +
      "`max_chars`, it is middle-pruned with a `[... pruned: ...]` marker. " +
      "Use this for normal commands where compact output is fine. For full " +
      "unpruned output, call `bash_raw` with the same `command` instead.",
    inputSchema: bashSafeSchema,
    handler: bashSafeHandler,
  },
  {
    name: "raw",
    description:
      "Execute a bash command and return its FULL output without pruning. " +
      "Use only when you specifically need unpruned output (e.g. dumping " +
      "a file, exact byte counts, or when a `bash_safe` marker tells you " +
      "the output was truncated). Output is capped only at `max_chars` " +
      "(default 500000) as a filesystem-safety guard; below that the " +
      "entire stdout+stderr is returned.",
    inputSchema: bashRawSchema,
    handler: bashRawHandler,
  },
]

type JsonRpcRequest = {
  jsonrpc: "2.0"
  id?: number | string | null
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: number | string | null | undefined
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function makeResponse(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result }
}

function makeError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } }
}

async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  switch (req.method) {
    case "initialize": {
      return makeResponse(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      })
    }

    case "notifications/initialized": {
      // Client notification — no response body.
      return makeResponse(req.id, {})
    }

    case "tools/list": {
      return makeResponse(req.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })
    }

    case "tools/call": {
      const params = req.params as
        | { name?: string; arguments?: Record<string, unknown> }
        | undefined
      const toolName = params?.name
      const args = params?.arguments ?? {}
      const tool = TOOLS.find((t) => t.name === toolName)
      if (!tool) {
        return makeError(req.id, -32602, `Unknown tool: ${toolName ?? "(none)"}`)
      }
      try {
        const result = await tool.handler(args)
        return makeResponse(req.id, result)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return makeResponse(req.id, {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        })
      }
    }

    case "ping": {
      return makeResponse(req.id, {})
    }

    default: {
      return makeError(req.id, -32601, `Method not found: ${req.method}`)
    }
  }
}

async function readStdin(): Promise<string> {
  // Streaming read — kullanılmıyor (aşağıdaki main loop streaming dispatch yapıyor).
  return ""
}

function parseLines(input: string): string[] {
  return input.split("\n").filter((l) => l.trim().length > 0)
}

function writeLine(obj: unknown): void {
  const line = JSON.stringify(obj) + "\n"
  fs.writeSync(1, line)
}

/**
 * Streaming dispatch: stdin'den satır satır JSON-RPC oku, hemen yanıtla.
 * EOF gelirse çık. SIGTERM/SIGINT de temiz kapatır.
 */
async function main(): Promise<void> {
  let buf = ""
  let closed = false

  const finish = () => {
    if (closed) return
    closed = true
    // Kalan buffer'daki son satırları da işle (best-effort).
    if (buf.trim().length > 0) {
      const trailing = parseLines(buf)
      buf = ""
      for (const line of trailing) {
        try {
          const req = JSON.parse(line) as JsonRpcRequest
          if (req.id !== undefined && req.id !== null) {
            // Son anda cevap veremeyiz, sadece hata göndeririz.
            writeLine(makeError(req.id, -32603, "Server shutting down"))
          }
        } catch {
          // ignore
        }
      }
    }
    process.exit(0)
  }

  process.on("SIGINT", finish)
  process.on("SIGTERM", finish)

  process.stdin.setEncoding("utf8")
  process.stdin.on("data", async (chunk: string) => {
    if (closed) return
    buf += chunk
    const lines = parseLines(buf)
    // Tam satır kalmadıysa (son parça eksik) buffer'da tut.
    if (!buf.endsWith("\n")) {
      const lastNl = buf.lastIndexOf("\n")
      if (lastNl < 0) return
      buf = buf.slice(lastNl + 1)
      // lines son eksik satırı içermez, çünkü parseLines split ederken
      // sondaki boş olmayan parçayı tutar. Yukarıdaki kontrol eksik.
    }
    buf = ""
    for (const line of lines) {
      let req: JsonRpcRequest
      try {
        req = JSON.parse(line) as JsonRpcRequest
      } catch (e) {
        writeLine(
          makeError(null, -32700, "Parse error", { detail: String(e) }),
        )
        continue
      }
      if (req.jsonrpc !== "2.0") {
        writeLine(makeError(req.id, -32600, "Invalid JSON-RPC version"))
        continue
      }
      const resp = await dispatch(req)
      if (req.id !== undefined && req.id !== null) {
        writeLine(resp)
      }
    }
  })

  process.stdin.on("end", finish)
  process.stdin.on("error", finish)
  process.stdin.on("close", finish)
}

main().catch((e) => {
  writeLine(makeError(null, -32603, "Server error", { detail: String(e) }))
  process.exit(1)
})
