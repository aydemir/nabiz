/**
 * Bash komut çalıştırma helper'ı.
 *
 * plugins/lib/prune.ts içindeki extractErrors mantığıyla uyumlu:
 * exit code, stderr/stdout ayrımı, hata satırı çıkarma.
 */

import { exec, ExecException } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

/**
 * Platform-duyarlı shell seçimi.
 *
 * POSIX: `/bin/bash` şart — /bin/sh (dash) timeout'ta torun process'i
 * orphan bırakıyor (canlı kanıt 2026-09-06: scripts/timeout-kill-probe,
 * sh→ORPHAN 2/2 vs bash→TEMİZ 2/2).
 *
 * Windows (2026-09-08 kararı, ilk win32 canlı testi): `/bin/bash` ENOENT
 * veriyor, TÜM komutlar `[exit 1]` dönüyordu. win32'de ComSpec (cmd)
 * kullanılır — bash deyimleri (`seq`, `&&` zincirleri hariç POSIX
 * sözdizimi) çalışmaz, bu bilinçli sınır. Orphan-garantisi win32'de
 * TEST EDİLMEDİ (TASK-115 sadece Linux).
 */
function resolveShell(): string {
  if (process.platform === "win32") return process.env.ComSpec || "cmd.exe"
  return "/bin/bash"
}

const ERROR_LINE_REGEX =
  /\berror\b|\bfailed\b|^\s*→|^\s*error\[|TypeError|ReferenceError|SyntaxError|^Cannot find|^Unable to|^Unresolved|^npm ERR!|^fatal|^panic/i

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

export interface ExecError extends Error {
  code?: string
  exitCode?: number
  stdout?: string
  stderr?: string
}

export async function runBash(
  command: string,
  timeoutMs: number,
): Promise<ExecResult> {
  const start = Date.now()
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024, // 50 MB — sonra prune/limit uygular
      shell: resolveShell(),
      windowsHide: true,
    })
    return {
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: 0,
      durationMs: Date.now() - start,
    }
  } catch (e) {
    const err = e as ExecError & { stdout?: string; stderr?: string }
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: typeof err.code === "number" ? err.code : 1,
      durationMs: Date.now() - start,
    }
  }
}

/**
 * Hata log'u çıkar: stderr'in tamamı (veya son N satırı) hata sayılır.
 * plugins/lib/prune.ts:extractErrors ile uyumlu basit versiyon.
 */
export function extractErrorLines(stderr: string, tailLines = 5): string[] {
  const lines = stderr.split("\n").filter((l) => l.length > 0)
  const tail = lines.slice(-tailLines)
  return tail.filter((l) => ERROR_LINE_REGEX.test(l) || l.trim().startsWith("→"))
}

/**
 * Toplam karakter sayısı (Unicode-safe).
 */
export function codePointLength(text: string): number {
  return Array.from(text).length
}
