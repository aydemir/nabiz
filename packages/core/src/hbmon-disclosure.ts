/**
 * hbmon kapalı-disclosure sabitleri (NABIZ-008).
 *
 * V2 (`@opencode/plugin`): plugin dosyası
 * (`plugins/opencode-hbmon.ts`) `export default Plugin.define(...)` yapar;
 * string sabitler burada toplanır (V1'deki TASK-111 pattern'inin devamı —
 * V1'de `getLegacyPlugins` modül export'larını `Object.values` ile iterate
 * edip her birinin function olmasını bekliyordu; string export plugin'in
 * hiç yüklenmemesine yol açıyordu).
 *
 * Tek satır (~15 token): kapalıyken tool yuvası kaybolduğu için "neden yok"
 * sorusunun cevabı. Sentinel-idempotent, oturum açılışında bir kez.
 */

export const HBMON_DISABLED_SENTINEL = "[hbmon-disabled]"

export const HBMON_DISABLED_TEXT = "[hbmon-disabled] opencode-hbmon kapalı, bg_run yok."
