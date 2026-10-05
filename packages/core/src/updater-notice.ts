/**
 * updater-notice — nabız'ın kendi sürüm güncelleme bildirimi (saf mantık).
 *
 * Neden var: opencode'in kendi plugin updater'ı (`ctrl+r`) nabız'ı GÖREMEZ.
 * Upstream `Npm.parse()` yalnızca npm registry ve git spec kabul ediyor; yerel
 * dizin yolu (`file:` tgz kurulumu) `isInstallablePackage()` false döner ve
 * envanterden tamamen düşer. Yani upstream tarafında görünmezlik bir bug
 * değil, bilinçli kapsam daraltması — bu yüzden bildirim nabız'ın kendi
 * sorumluluğunda.
 *
 * Ağ katmanı burada YOK: `checkForUpdate()` en güncel sürümü bir callback'ten
 * alır, testler dosya sistemine ve gerçek network'e dokunmadan üretim yolunu
 * test edebilir. Gerçek `fetch` plugin katmanında enjekte edilir.
 */

/** Disclosure idempotency işareti — sistem prompt'a bir kez gömülür. */
export const UPDATE_SENTINEL = "[nabiz-updater]"

export const DEFAULT_PACKAGE = "nabiz-opencode"
export const DEFAULT_REGISTRY = "https://registry.npmjs.org"
/**
 * Registry soğuk istek süresi 2026-10-05'te ölçüldü: ilk `fetch` (DNS+TLS)
 * **~5.4 sn** sürüyor. 5 sn'lik timeout onu kesiyor, `catch` AbortError'ı
 * yutuyor ve fetcher `undefined` dönüyor — updater "güncelleme yok" diye
 * sessizce geçiyor. Ölçülen 5.4 sn'in üstünde, üstelik bu istek oturumda
 * **bir kez** çalıştığı için 15 sn rahatlıkla katlanır.
 */
export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Sürüm karşılaştırma. `a > b` ise pozitif, eşitse 0, küçükse negatif.
 *
 * Prerelease/derleme eklerini yok sayar (`1.2.0-rc.1` → `1.2.0`): registry
 * `dist-tags.latest` zaten prerelease göstermez, karşılaştırma yalnızca
 * "kurulu sürüm geride mi" sorusuna cevap verir. Sayı olmayan segment
 * (`1.x`) 0 sayılır — bozuk bir sürüm alanı tüm bildirimi düşürmemeli.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .split("-")[0]
      .split(".")
      .map((part) => {
        const n = Number.parseInt(part, 10)
        return Number.isFinite(n) ? n : 0
      })
  const left = parse(a)
  const right = parse(b)
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Kurulu sürüm geride mi? Sürüm okunamıyorsa "bilinmiyor" → false (sessiz). */
export function isOutdated(installed: string, latest: string): boolean {
  if (!installed || !latest) return false
  return compareVersions(latest, installed) > 0
}

export interface NoticeInput {
  installed: string
  latest: string
  packageName?: string
}

/**
 * Bildirim metni. Updater otomatik kurulum YAPMAZ — upstream'in `ignoreScripts`
 * kısıtı burada da geçerli: kurulum `setup.mjs --yes` ile bilinçli bir adım.
 */
export function buildUpdateNotice(input: NoticeInput): string {
  const name = input.packageName ?? DEFAULT_PACKAGE
  return (
    `${UPDATE_SENTINEL} Yeni sürüm var: ${input.installed} → ${input.latest} (${name}). ` +
    "Bu plugin'ı ASLA kendin güncelleme (kurulum `npm install` + build gerektirir, " +
    "kullanıcının `setup.mjs --yes` adımına bağlıdır). Yalnızca haber ver, kararı kullanıcıya bırak."
  )
}

/** Bildirimin kullanıcıya görünen kısa özeti — testler ve loglar için. */
export function formatSummary(input: NoticeInput): string {
  const name = input.packageName ?? DEFAULT_PACKAGE
  return `${name} ${input.installed} → ${input.latest}`
}

/**
 * En güncel sürümü okuyan callback. Ağ hatası / 404 / zaman aşımı `undefined`
 * döner — HATA DEĞİL, normal durum (paket registry'de henüz yok olabilir).
 */
export type FetchLatest = () => Promise<string | undefined>

export interface CheckResult {
  installed: string
  latest?: string
  outdated: boolean
}

/**
 * Tek kontrol. Kurulum sürümü okunamıyorsa veya uzak sürüm alınamazsa sessiz
 * geçer — updar session'ı ASLA bloklamaz, ASLA throw etmez.
 */
export async function checkForUpdate(installed: string, fetchLatest: FetchLatest): Promise<CheckResult> {
  if (!installed) return { installed, outdated: false }
  let latest: string | undefined
  try {
    latest = await fetchLatest()
  } catch {
    // Ağ katmanı beklenmedik biçimde patlarsa (timeout, DNS, kesik bağlantı)
    // bildirim yok sayılır: updater'ın tek işi bilgi vermek, hata üretmek değil.
    return { installed, outdated: false }
  }
  if (!latest) return { installed, outdated: false }
  return { installed, latest, outdated: isOutdated(installed, latest) }
}

/** Gerçek registry okuyucu. `dist-tags.latest` tek istekte yeter. */
export function createRegistryFetcher(
  packageName: string = DEFAULT_PACKAGE,
  registry: string = DEFAULT_REGISTRY,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): FetchLatest {
  return async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${registry}/${packageName}`, { signal: controller.signal })
      if (!response.ok) return undefined
      const body = (await response.json()) as { "dist-tags"?: { latest?: unknown } }
      const latest = body["dist-tags"]?.latest
      if (typeof latest !== "string" || latest === "") return undefined
      return latest
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
}
