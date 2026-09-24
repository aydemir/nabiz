/**
 * Build-tracker disclosure sabitleri (TASK-129).
 *
 * opencode 1.18.29 `getLegacyPlugins` kuralı: plugin dosyası
 * (`plugins/opencode-build-tracker.ts`) sadece `default` export eder;
 * string sabitler burada toplanır (TASK-111 pattern'i).
 *
 * Kısa tutulur (~45 token, cs presedenti): LLM'in bilmeden
 * kullanamayacağı tek şey `extraErrorPatterns` + `app.log` satırlarının
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
  "(e.g. pytest: [\"^FAILED\\s\"]). Status lands in app.log as " +
  "`Build success/failed: <cmd>`; stdout stays silent (no toast, no chat) — " +
  "check app.log for the verdict, tool output for details."
