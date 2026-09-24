/**
 * readRawRefill — per-call `disableForCalls` sayaç doldurma helper'ı.
 *
 * context-saver plugin'inden taşındı (2026-09-05) — kök neden için
 * `lib/disclosure.ts` başlığına bak. Bu dosya pure helper; testler
 * lib'den import eder.
 *
 * Davranış: `args.disableForCalls` veya `args.disable_for_calls`
 * pozitif tamsayı (veya sayısal string) ise döndür, yoksa undefined.
 */
export function readRawRefill(args: unknown): number | undefined {
  if (typeof args !== "object" || args === null) return undefined
  const o = args as Record<string, unknown>
  const v = o.disableForCalls ?? o.disable_for_calls
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN
  return Number.isInteger(n) && (n as number) > 0 ? (n as number) : undefined
}