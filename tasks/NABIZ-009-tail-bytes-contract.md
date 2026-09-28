---
id: NABIZ-009
title: "bg_logs tail_bytes sözleşmesi ile gerçek cap uyuşmuyor (512000 ↔ 51200)"
status: done (P1 dürüstlük; P2 politika açık)
priority: P1
created: 2026-09-27
updated: 2026-09-28
labels: [bg-hbmon, contract, context-economy]
depends_on: []
---

# NABIZ-009 — bg_logs `tail_bytes` sözleşme/cap uyuşmazlığı

## Amaç

Kullanıcı = LLM ajanı. `bg_logs` `tail_bytes` için *"default 51200,
max 512000"* diyor ve 512000'e kırpıyor — ama **cursor modunda** (yani
NABIZ-001'in getirdiği normal artımlı-okuma yolunda) içeride ikinci bir
kırpma var ve 50 KB üzeri **hiçbir zaman** dönemiyor. Ajan 400 KB ister,
50 KB alır, ve bunun istediğinden az olduğunu **öğrenemez**.

İlham: minimax-code ayrımı yapıyor — `DEFAULT_OUTPUT_READ_LIMIT_BYTES`
bir **default**, `limitBytes` **çağrı başına geçersiz kılınabilir** bir tavan
(`types.ts:50`), ve yanıt `truncated=` ile durumu dürüstçe bildiriyor.
nabiz'de de `truncated` var, ama **sessiz** bir üst kırpma var.

## İnceleme Kaydı (2. göz, 2026-09-27)

| # | Sınıf | Bulgu | Kanıt | Hüküm |
|---|---|---|---|---|
| C1 | sözleşme | Açıklama "max 512000" diyor | `opencode-hbmon.ts:328` | DOĞRULANDI |
| C2 | sözleşme | **tail modu** 512 KB'ye kadar gidiyor | `opencode-hbmon.ts:337` `Math.min(Math.max(…, 1), 512*1024)` | DOĞRULANDI |
| C3 | sözleşme | **cursor modu** içeride `OUT_CURSOR_CAP`'a kırpılıyor → etkin tavan 50 KB | `opencode-hbmon.ts:342` → `bg-tasks.ts:130` `Math.min(…, OUT_CURSOR_CAP)`; sabit `bg-tasks.ts:119` | DOĞRULANDI |
| C4 | sözleşme | Aynı parametre, iki farklı etkin tavan; model bunu ayırt edemiyor | C2 + C3 | DOĞRULANDI |
| C5 | iç tutarlılık | Kırpma **sessiz** — receipt'te `offset/next_offset/size/TRUNCATED` var ama "istedin, 50 KB verdim" bilgisi yok | `bg-tasks.ts:150-164` | DOĞRULANDI |
| C6 | öncelik | **50 KB cap kastî**, rastgele bir sabit değil: hbmon `TASK-050` bu cap'i açıkça *"tüm `.out`'u (50KB cap ile) okumak zorunda"* diye anıyor ve `context-economy` etiketli | `hbmon/tasks/done/TASK-050-exit-summary.md` | DOĞRULANDI |
| — | risk | Bu bir veri kaybı değil: `.out` diskte, `next_offset` ile kalanı sonraki çağrıda alınır | `bg-tasks.ts:121-148` | KISMEN (kayıp yok, bağlam/beklenmedik maliyet var) |

**C6 sonucunu değiştirir:** cap'i kaldırmak/büyütmek bir *düzeltme* değil,
hbmon tarafında da gerekçelendirilmiş bir politikanın **gevşetilmesi**dir.
Tek satırlık gerçek hata **açıklamanın yalan söylemesi**dir.

## Kapsam

**P1 — dürüstlük (tek satır, düşük risk, hemen):**

- Tool açıklaması gerçek davranışı söylesin: tail modunda 512 KB, cursor
  modunda 50 KB. Bugün tek "max 512000" diyor ve cursor modunu kapsıyor gibi
  görünüyor.
- Kırpma sessiz geçmesin: cursor modunda istenen değer etkin değilse
  receipt'e `capped="<etkin>"` alanı eklensin. `truncated` ("kuyrukta daha
  var, `next_offset`'ten devam") ile `capped` ("sana istediğinden az verdim")
  ayrımı net olsun — ikisi farklı karar yönlendirir.

**P2 — politika (ayrı karar, gerekçe ister):**

- `tail_bytes` cursor modunda da tam uygulansın (belgelenen maksimuma kadar).
  Bu **bağlam ekonomisi** kararını gevşetir: tek `bg_logs` çağrısı 512 KB
  enjekte edebilir. hbmon `TASK-050` bu cap'i `context-economy` gerekçesiyle
  seçti, bu yüzden varsayılan **yükseltilmemeli**.
- Öneri: etkin tavanı yükseltme, `tail_bytes`'ı isteyen çağrıya **uygula**
  ama `OUT_CURSOR_CAP` değerini koru. Yani kazanan model: *default* sabit
  kalır, *istek* tutulur — mcode'un ayrımı (`DEFAULT_OUTPUT_READ_LIMIT_BYTES`
  default, `limitBytes` çağrı başına geçersiz kılınabilir).

**Yapılmayacaklar**

- `.out` okuma modelinin değişmesi (NABIZ-001 cursor protokolü korunur).
- Ring buffer / yeni depolama (NABIZ-001'de bilinçli yok sayıldı).
- `bg_status` çıktı şekli.
- Cap'i **sessizce** yükseltmek — yukarıdaki iki kalem ayrı ayrı değerlendirilir.

## Uygulama Planı

1. `readOutCursor`'da `OUT_CURSOR_CAP` sabitini kaldır; `maxBytes` gelen
   değeri kullansın (varsayılan 50 KB korunur).
2. Yanıta `capped` alanı; `opencode-hbmon.ts:342` receipt'e ekle.
3. Tool description'ı gerçek davranışla eşleştir (tail vs cursor tavanı
   ayrı ayrı yazılmalı).
4. `bg-tasks.test.mjs`: kırpma senaryosu.

## Etkilenen Dosyalar

- `packages/core/src/bg-tasks.ts` (`OUT_CURSOR_CAP`, `readOutCursor`, receipt)
- `packages/harness-opencode/plugins/opencode-hbmon.ts` (açıklama + receipt)
- `packages/harness-opencode/tests/bg-tasks.test.mjs`

## Doğrulama

**P1 (dürüstlük) — 2026-09-28 uygulandı, testler yeşil:**

- `readOutCursor` cap aşımında `capped` (etkin tavan) dönüyor
  (`packages/core/src/bg-tasks.ts`), `formatCursorReceipt` başlığa
  `capped="<etkin>"` yazıyor; cap politikası değişmedi (P2'ye dokunulmadı —
  plan adım 1'deki "sabiti kaldır" bilinçli uygulanmadı).
- Tool + parametre açıklamaları iki tavanı ayrı yazıyor
  (`packages/harness-opencode/plugins/opencode-hbmon.ts`: tool "tail
  modunda max 512KB … cursor modda tavan 50KB", param "tail modunda max
  512000, cursor modunda max 51200").
- Canlı kanıt (300 KB `.out`): `offset=0 tail_bytes=262144` → 51200 bayt +
  `capped="51200"`; `tail_bytes=999999` → yine `capped="51200"`, panik yok;
  default istekte `capped` yok; devam (`offset=51200`) temiz.
- Testler: `readOutCursor` capped + `formatCursorReceipt` capped + `bg_logs`
  plugin seviyesi capped (`packages/harness-opencode/tests/bg-tasks.test.mjs`).
  `bg-tasks.test.mjs` 12/12 daemon'suz test yeşil; 7 hata baz ile aynı
  (önceden var: bg-wake cwd yolu + adapter mock'ları, bu işle ilgisiz).
- `offset` verilmeden (tail modu) davranış bit-bazında aynı (test 4+8 yeşil);
  NABIZ-001 `[tekrar]` mantığına dokunulmadı (test 6+8 yeşil).

Aşağıdaki maddeler uygulama öncesi yazıldı, P1 satırları yukarıdaki
gerçekleşenle değiştirildi (P2 hâlâ açık):

- `bg_logs offset=0 tail_bytes=262144` → yanıt receipt'inde
  `capped="51200"` **görünür** (bugün sessizce 50 KB).
- `tail_bytes=999999` → yine `capped="51200"`, panik/hata yok.
- Tool açıklaması artık cursor modunun 50 KB tavanını **belirtiyor**.
- `offset` verilmeden (tail modu) mevcut 512 KB davranışı **bit-bazında** aynı.
- NABIZ-001'in tekrar-uyarısı (`[tekrar]`) kırpma durumunda yanlış tetiklenmiyor.

**P2 (politika, ayrı onayla):**

- 300 KB'lık `.out` üret → `offset=0 tail_bytes=262144` → **256 KB** döner.
- Context maliyeti ölçülür: 256 KB'ın tek çağrıda enjekte edilmesi kabul
  mü, yoksa `max 512000` ifadesi geri mi çekilmeli? Karar
  `decisions.md`'ye gerekçesiyle yazılır.
