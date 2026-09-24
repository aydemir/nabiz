#!/usr/bin/env node
// scripts/cpu-liveness-probe/io-wait.js
// Mesru-bekleme siniflandirici (M1, TASK-117) — SAF fonksiyonlar, I/O yok.
//
// Stall ateslendiginde (delta==0) soru sudur: "CPU almiyor" = asili mi,
// mesru bekleme mi (indirme, kilit, ag)? Bu modul SADECE taze ciktiya
// bakarak olasilik sinyali uretir — HUKUM DEGILDIR (doktrin):
//
//   - Tazelik penceresi: bayat log satiri ("downloading" 10dk once kalmis)
//     sayilmaz. entries[] {t, line} tasir; nowMs - t <= freshMs sarti aranir.
//   - Cap: tolerans tur sayisi agent'ta sinirlanir (ioGraceRounds); siniflandirma
//     tek basina sonsuz bekleme uretemez. Butce (M4) hicbir toleransa danisilmaz.
//   - CPU yakan process'te stall ateslenmedigi icin bu modul HIC devreye
//     girmez (M1xM3 celiskisi kodda cozulur: tolerans sadece onStall icinde).
//
// Liste bilerek kisa ve Ingilizce-arac kelimeleri: heuristic oldugu acik.
// "Compiling/Finished/error" bilerek YOK (CPU isi / sonuc, bekleme degil).

export const IO_WAIT_PATTERNS = [
  /download(ing|ed)?/i,
  /fetch(ing)?/i,
  /\block(ing|ed)?\b/i,
  /\bwait(ing)?\b/i,
  /waiting for/i,
  /\bretry(ing)?\b/i,
];

export const IO_FRESH_MS_DEFAULT = 15000;
export const IO_GRACE_ROUNDS_DEFAULT = 3;

/**
 * hasFreshLegitWait(entries, nowMs, freshMs): taze pencerede eslesen
 * ilk satiri doner, yoksa null. entries = [{t: epochMs, line: string}].
 */
export function hasFreshLegitWait(entries, nowMs, freshMs = IO_FRESH_MS_DEFAULT) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || typeof e.line !== "string" || typeof e.t !== "number") continue;
    if (nowMs - e.t > freshMs) continue; // bayat — sayilmaz
    if (IO_WAIT_PATTERNS.some((re) => re.test(e.line))) return e.line;
  }
  return null;
}
