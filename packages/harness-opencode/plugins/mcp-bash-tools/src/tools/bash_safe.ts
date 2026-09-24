/**
 * bash_safe: middle-prune + marker (default).
 *
 * Schema:
 *   command: string (required) — bash -c komutu
 *   description: string — komut açıklaması (LLM context için)
 *   max_chars?: number (default 30000) — bu üstüne çıkarsa kırpılır
 *   head_chars?: number (default 200) — kırpılmış halde baştan
 *   tail_chars?: number (default 200) — kırpılmış halde sondan
 *   timeout_ms?: number (default 30000) — exec timeout
 */

import { codePointLength, extractErrorLines, runBash } from "../exec.js"

export const bashSafeSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "Bash command to execute (passed to bash -c; on Windows: ComSpec/cmd semantics).",
    },
    description: {
      type: "string",
      description: "Short human-readable description of what this command does.",
    },
    max_chars: {
      type: "number",
      description:
        "Output size threshold (in characters). Outputs larger than this " +
        "are middle-pruned with a marker. Default 30000.",
      default: 30000,
    },
    head_chars: {
      type: "number",
      description: "Number of characters kept from the start when pruning. Default 200.",
      default: 200,
    },
    tail_chars: {
      type: "number",
      description: "Number of characters kept from the end when pruning. Default 200.",
      default: 200,
    },
    timeout_ms: {
      type: "number",
      description: "Execution timeout in milliseconds. Default 30000 (30s).",
      default: 30000,
    },
  },
  required: ["command", "description"],
  additionalProperties: false,
} as const

const MARKER_FORMAT =
  "\n\n[... pruned: {original}→{kept} chars ({saved}% saved). For raw output, call bash_raw with the same command. ...]\n\n"

function pruneMiddle(
  text: string,
  headChars: number,
  tailChars: number,
  maxChars: number,
): { pruned: string; originalChars: number; keptChars: number } {
  const originalChars = codePointLength(text)
  if (originalChars <= maxChars) {
    return { pruned: text, originalChars, keptChars: originalChars }
  }
  const head = Array.from(text).slice(0, headChars).join("")
  const tail = Array.from(text).slice(-tailChars).join("")
  const keptChars = headChars + tailChars
  const saved =
    originalChars === 0
      ? 0
      : Math.round(((originalChars - keptChars) / originalChars) * 1000) / 10
  const marker = MARKER_FORMAT.replace("{original}", String(originalChars))
    .replace("{kept}", String(keptChars))
    .replace("{saved}", String(saved))
  return { pruned: head + marker + tail, originalChars, keptChars }
}

export async function bashSafeHandler(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const command = args.command
  if (typeof command !== "string" || command.length === 0) {
    return {
      isError: true,
      content: [{ type: "text", text: "Error: `command` is required and must be a non-empty string." }],
    }
  }
  const description = typeof args.description === "string" ? args.description : ""
  const maxChars = typeof args.max_chars === "number" && args.max_chars > 0 ? args.max_chars : 30000
  const headChars = typeof args.head_chars === "number" && args.head_chars >= 0 ? args.head_chars : 200
  const tailChars = typeof args.tail_chars === "number" && args.tail_chars >= 0 ? args.tail_chars : 200
  const timeoutMs = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 30000

  const result = await runBash(command, timeoutMs)
  const combined = result.stdout + (result.stderr ? "\n" + result.stderr : "")

  // Hata varsa: ham stderr'i göster (kırpma yok).
  if (result.exitCode !== 0) {
    const errLines = extractErrorLines(result.stderr || combined)
    const text = errLines.length > 0
      ? `⚠️ ${description}\n${errLines.join("\n")}\n⏱️ ${result.durationMs}ms (exit ${result.exitCode})`
      : `⚠️ ${description}\n[exit ${result.exitCode}]\n${result.stderr || combined.slice(0, 1000)}\n⏱️ ${result.durationMs}ms`
    return { isError: true, content: [{ type: "text", text }] }
  }

  const { pruned, originalChars, keptChars } = pruneMiddle(combined, headChars, tailChars, maxChars)
  const wasPruned = originalChars > maxChars
  const summary = wasPruned
    ? `[${description}] (${originalChars} chars → pruned to ${keptChars})`
    : `[${description}]`

  const text = `${summary}\n${pruned}\n⏱️ ${result.durationMs}ms`
  return { content: [{ type: "text", text }] }
}
