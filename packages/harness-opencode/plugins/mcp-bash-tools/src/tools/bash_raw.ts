/**
 * bash_raw: full output (no prune).
 *
 * Schema:
 *   command: string (required)
 *   description: string
 *   max_chars?: number (default 500000) — sadece DOSYA KORUMA guard'ı
 *   timeout_ms?: number (default 30000)
 */

import { codePointLength, extractErrorLines, runBash } from "../exec.js"

export const bashRawSchema = {
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
        "Filesystem-safety guard: truncate output above this size. " +
        "Default 500000 (500 KB). This is NOT a prune — output is cut, " +
        "not middle-pruned. For normal commands, prefer `bash_safe`.",
      default: 500000,
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

export async function bashRawHandler(
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
  const maxChars = typeof args.max_chars === "number" && args.max_chars > 0 ? args.max_chars : 500000
  const timeoutMs = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 30000

  const result = await runBash(command, timeoutMs)
  const combined = result.stdout + (result.stderr ? "\n" + result.stderr : "")

  if (result.exitCode !== 0) {
    const errLines = extractErrorLines(result.stderr || combined)
    const text = errLines.length > 0
      ? `⚠️ ${description}\n${errLines.join("\n")}\n⏱️ ${result.durationMs}ms (exit ${result.exitCode})`
      : `⚠️ ${description}\n[exit ${result.exitCode}]\n${result.stderr || combined.slice(0, 1000)}\n⏱️ ${result.durationMs}ms`
    return { isError: true, content: [{ type: "text", text }] }
  }

  const len = codePointLength(combined)
  const truncated = len > maxChars
  const output = truncated ? Array.from(combined).slice(0, maxChars).join("") : combined
  const text = truncated
    ? `[${description}] (TRUNCATED at ${maxChars} chars — full size ${len})\n${output}\n⏱️ ${result.durationMs}ms`
    : `[${description}]\n${output}\n⏱️ ${result.durationMs}ms`
  return { content: [{ type: "text", text }] }
}
