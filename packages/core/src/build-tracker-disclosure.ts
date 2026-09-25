/**
 * Build-tracker disclosure sabitleri (TASK-129).
 *
 * V2 (`@opencode/plugin`): plugin dosyası
 * (`plugins/opencode-build-tracker.ts`) `export default Plugin.define(...)`
 * yapar; string sabitler burada toplanır (V1'deki TASK-111 pattern'inin
 * devamı — V1'de `getLegacyPlugins` Object.values kuralı vardı).
 *
 * Kısa tutulur (~45 token, cs presedenti): LLM'in bilmeden
 * kullanamayacağı tek şey `extraErrorPatterns` + kayıt satırlarının
 * anlamı; gerisi pasif davranış.
 */

export const BUILD_TRACKER_SENTINEL = "[build-tracker]"

export const BUILD_TRACKER_TEXT =
  "[build-tracker] Build lifecycle hooks are active. Triggers: " +
  "cargo/npm/pnpm/yarn/bun/make/cmake/gradle/mvn/go/tsc/vite/pytest/jest/vitest " +
  "first-token (+ `npm run`, `docker build`, `pip install`, `python -m`, " +
  "`npx jest/vitest` phrases); shell segments split on |/&&/;. " +
  "Timed (thresholdMs, default 120s) — overruns log `[Build Hook] onThresholdExceeded` " +
  "but keep running. Failures match error lines plus `extraErrorPatterns` " +
  "(e.g. pytest: [\"^FAILED\\s\"]). Status is recorded in plugin storage as " +
  "`Build success/failed: <cmd>`; stdout stays silent (no toast, no chat) — " +
  "tool output carries the details."
