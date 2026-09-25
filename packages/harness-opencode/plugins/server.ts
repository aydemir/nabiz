/**
 * nabiz-opencode plugin paketi — V2 barrel.
 *
 * V1'de (`opencode 1.18.x`, `getLegacyPlugins`) bu modülün TÜM export
 * değerleri iterate edilip her function ayrı plugin instance olarak
 * yükleniyordu; o yüzden dosya SADECE altı factory export ediyordu.
 *
 * V2'de (`opencode 2.x`, `@opencode/plugin`) her plugin dosyası kendi
 * başına bir plugindir (`export default Plugin.define(...)`) ve canlı
 * config tek tek dosya yollarını listeler. Bu dosya runtime'da plugin
 * olarak YÜKLENMEZ — sadece tek noktadan import kolaylığı (testler,
 * dokümantasyon) için altı default export'u isimli olarak re-export eder.
 */

export { default as contextSaver } from "./opencode-context-saver.js"
export { default as buildTracker } from "./opencode-build-tracker.js"
export { default as truncationNoticer } from "./opencode-truncation-noticer.js"
export { default as cpuLiveness } from "./opencode-cpu-liveness.js"
export { default as settleNoticer } from "./opencode-settle-noticer.js"
export { default as hbmon } from "./opencode-hbmon.js"
