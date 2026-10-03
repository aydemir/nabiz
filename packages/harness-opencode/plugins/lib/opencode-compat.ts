/**
 * opencode-compat — host varsayım tamponu (NABIZ-011/012 dersleri).
 *
 * İlham: slim `src/v2/adapters.ts` + `setup.ts` — host kurallarını çağıran
 * kodun içine gömmek yerine tek modülde topla, varsayım kayınca tek
 * yerden patlasın. Fark: nabız'da V1 kodu yok; bu modül V2 host
 * varsayımlarını (ad/namespace biçimi, hook adları, izin sözlüğü)
 * merkeziler ve kayıt anında yüksek sesle doğrular — hostun sessiz
 * düşürmesine karşı fail-loud.
 *
 * Kurallar opencode 2.0.21 binary içi kaynaktan (canlı kanıt 2026-10-02/03):
 * - namespace: `ns.split(".").every(seg => /^[A-Za-z0-9_-]{1,64}$/)`
 *   (nokta AYIRICI; uymayan "Skipping invalid tool registration" ile düşer)
 * - tool adı: `/^[A-Za-z0-9_-]{1,128}$/` + `execute` rezerve (CodeMode)
 */

import type { Info } from "@opencode/plugin/promise/tool"
import type { Tool } from "@opencode/schema/tool"

export class CompatError extends Error {}

/** Fully-qualified tool adı kuralı (host `pl()`). */
export const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Namespace SEGMENT kuralı (host `fl()`; nokta ayırıcıdır). */
export const NAMESPACE_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/

/** CodeMode için rezerve tool adları. */
export const RESERVED_TOOL_NAMES = new Set(["execute"])

/** Kanca adları — yazım kayması sessizce boşa düşer, buradan alınır. */
export const HOOK_SESSION_CONTEXT = "context"
export const HOOK_SESSION_PROMPT = "prompt"
export const HOOK_TOOL_BEFORE = "execute.before"
export const HOOK_TOOL_AFTER = "execute.after"

/**
 * V1→V2 izin sözlüğü (slim `adaptPermissions` karşılığı). Nabız tool'ları
 * V2 sözcükleriyle yazılır; tablo, eski sözcükle gelen girdiyi
 * normalleştirir (örn. harici şablonlardan kopyalanan `task` → `subagent`).
 */
const PERMISSION_WORD_MAP: Record<string, string> = {
  task: "subagent",
  bash: "execute",
}

export function adaptPermissionWord(word: string): string {
  return PERMISSION_WORD_MAP[word] ?? word
}

export function assertValidToolName(name: string): void {
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name)) {
    throw new CompatError(`geçersiz tool adı ${JSON.stringify(name)} — host kuralı ${TOOL_NAME_RE} (sessiz düşer)`)
  }
  if (RESERVED_TOOL_NAMES.has(name)) {
    throw new CompatError(`tool adı rezerve: ${JSON.stringify(name)} (CodeMode için ayrılmış)`)
  }
}

export function assertValidNamespace(namespace: string): void {
  const ok =
    typeof namespace === "string" &&
    namespace.length > 0 &&
    namespace.split(".").every((seg) => NAMESPACE_SEGMENT_RE.test(seg))
  if (!ok) {
    throw new CompatError(
      `geçersiz tool namespace ${JSON.stringify(namespace)} — host kuralı: nokta-ayırıcılı segmentler ${NAMESPACE_SEGMENT_RE} (sessiz düşer)`,
    )
  }
}

/**
 * Kayıt öncesi normalleştirme + doğrulama. Jenerikler `editor.add` ile
 * birebir aynı çıkarımı yapar (`Info<I, O>`), o yüzden `execute`
 * parametreleri bağlamsal tipini kaybetmez. Geçerli girdiyi aynen
 * geçirir; bozuk girdide `CompatError` atar (hostun sessiz düşürmesi
 * yerine setup anında yüksek sesli hata).
 * `editor.add(adaptToolInfo({...}))` biçiminde kullanılır.
 */
export function adaptToolInfo<
  I extends Tool.ValueSchema<any> = Tool.ValueSchema<any>,
  O extends Tool.ValueSchema<any> | undefined = Tool.ValueSchema<any> | undefined,
>(info: Info<I, O>): Info<I, O> {
  assertValidToolName(info.name)
  if (info.options?.namespace !== undefined) assertValidNamespace(info.options.namespace)
  if (info.options?.permission !== undefined && info.options.permission !== "") {
    return { ...info, options: { ...info.options, permission: adaptPermissionWord(info.options.permission) } }
  }
  return info
}
