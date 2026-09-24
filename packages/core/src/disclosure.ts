/**
 * Disclosure sabitleri — context-saver plugin'inden taşındı (2026-09-05).
 *
 * Kök neden: opencode 1.18.29 `getLegacyPlugins`
 * (packages/opencode/src/plugin/index.ts:107) tüm modül export'larını
 * iterate edip (`Object.values(mod)`) her birinin function olmasını
 * bekliyor. String export'lar (`DISCLOSURE_SENTINEL`, `DISCLOSURE_TEXT`)
 * `TypeError("Plugin export is not a function")` fırlatıyor ve plugin
 * instance'ı hiç yüklenmiyor — tüm hook'lar (disclosure + prune) sessizce
 * kayboluyor. Canlı test kanıtı: `/tmp/opencode-disclosure-test/t12-cs-disclosure.log`
 * (LLM "Yok" dedi `[context-saver]` marker'ına).
 *
 * Bu dosyayı sadece testler ve dışarıdan referans veren kod import eder;
 * plugin dosyası (`plugins/opencode-context-saver.ts`) sadece `default`
 * export eder. Aynı pattern TASK-111'de `lib/truncation-notice.ts` için
 * uygulandı (orada çalıştı; burada da uygulanmalı).
 *
 * Birli `lib/`: uzun vadede TÜM pluginlerin string export'ları buraya
 * taşınmalı, ayrı `lib/disclosure.ts` / `lib/build-state.ts` vb. P3 refactor.
 */

export const DISCLOSURE_SENTINEL = "[context-saver]"

/**
 * Oturum başında LLM'e bir kez enjekte edilen kaçış notu. Kısa tutulur
 * (~40 token); tam mekanizma ilk kırpma marker'ında zaten verilir.
 */
export const DISCLOSURE_TEXT =
  "[context-saver] Native `bash` output over threshold is middle-pruned " +
  "(marker `[... pruned: N→M chars (X% saved) ...]`; first prune in session " +
  "carries the full escape list, later ones are short). " +
  "`read`/`grep`/`glob` are NEVER pruned (skipTools) — what you see is full. " +
  "MCP `bash_safe`/`bash_raw` decide their own pruning (plugin never " +
  "double-prunes them). Raw output, in order: embed `#no-prune` in tool " +
  "args (skipWhenContains, honored) | call MCP `bash_raw` | " +
  "`alwaysRawCommands` whitelist (config) | `disableForCalls=N` (next N " +
  "raw) | `enabled:false` (off)."