# nabız — Task Board (2026-09-23)

Kaynak: minimax-code arka plan mimarisi incelemesi (2. göz dahil). hbmon
daemon tarafı işler hbmon reposunda (`TASK-050`); burası yalnızca extension
katmanıdır.

## Hedef Kilidi

> **hbmon'un vaadi extension'da bozulmaz:** restart'ı atlatma, context
> ekonomisi, polling YOK disiplini prompt'ta değil runtime'da da tutulur.

## Board

| ID | Başlık | Status | Priority |
|----|--------|--------|----------|
| NABIZ-001 | bg_logs cursor (offset/next_offset/truncated + tekrar uyarısı) | done (stub+daemon 6/6) | P1 |
| NABIZ-002 | Task registry persist (restart durability) | done (registry 0600 + merge) | P1 |
| NABIZ-003 | bg_logs wait_ms (hbmon wait reuse) | done (wait 17/17 canlı) | P2 |
| NABIZ-004 | Foreground MCP çağrılarında TUI spinner'ı (sıfır kod) | done (README + motor kanıtı) | P2 |
| NABIZ-005 | Background işler için progress watcher (event-driven) | done (events reuse + bg_status) | P3 |
| NABIZ-006 | Windows npm workspace symlink (EPERM) | todo (not eklendi, canlı kanıt bekler) | P2 |
| NABIZ-007 | Native background shell kör noktası (Shell finished) | done (shell.started/ended takibi) | P2 |
| NABIZ-008 | hbmon kill-switch'i yapısal (7 tool kayıt altında) | done (erken-dönüş + `[hbmon-disabled]` disclosure, 3 test) | P2 |
| NABIZ-009 | bg_logs tail_bytes sözleşmesi ↔ gerçek cap (512000 ↔ 51200) | done P1 (açıklama + `capped=`); P2 politika açık | P1 |
| NABIZ-010 | Wake mesajı üçlü kopyası (core `wakeMessage` üretimde ölü) | done (`bg-wake` import'lar, üretim-yolu testi) | P2 |

Sıra: `NABIZ-001 → NABIZ-002 → NABIZ-003` (003, 001'e bağlı; 001-002 bağımsız,
paralel yapılabilir). `NABIZ-004 ↔ NABIZ-005` bağımsız, paralel yapılabilir;
004 sıfır kod olduğu için önce bitirilir.

## Ertelenenler (bilinçli, 2. göz kararı)

- **Soft-yield auto-background:** pi'nin `bash` tool'u extension'dan intercept
  edilemez; mimari engel. Prompt heuristiği ("sürecek işi `bg_run` ile başlat")
  yeterli.
- **Delivery burst limiti:** minimax'teki (60s'de 3 turn) onlarca task'lı cloud
  içindi; pi oturumunda 1-3 task var, fırtına kanıtı yok. Mevcut durable
  bildirim + `adoptOrphans` yeterli.
- **Watchdog default tavan:** minimax `max(30dk, explicit)` yapıyor ama hbmon
  dev server/watcher destekliyor — kör default server'ları öldürür. Kind-aware
  tavan gerektirir; kanıt birikince hbmon tarafında ayrı TASK açılır.

## 2. Göz Yeniden Değerlendirme (2026-09-27)

Board'un kendi kaynak satırı (*"minimax-code arka plan mimarisi incelemesi"*)
ters yönde çalıştırıldı: mcode'dan **nabiz'e** kalan ne var. Yöntem hbmon
`TASK-047`'deki 2. göz disiplini — her iddia kanıt tablosuyla,
doğrulanamayanlar ayrı işaretleniyor, hedef kilidine çarpanlar reddediliyor.

### Doğrulanan ve göreve dönenler

| Bulgu | Kanıt | Görev |
|---|---|---|
| `enabled:false` iken 7 tool kayıtlı kalıyor | `opencode-hbmon.ts:157,188,205,227,295,332,353` | NABIZ-008 |
| `tail_bytes` "max 512000" diyor, cursor modunda 50 KB'a kırpılıyor — sessiz | `opencode-hbmon.ts:328,337,342` → `bg-tasks.ts:119,130` | NABIZ-009 (P1: açıklama + `capped=`; P2: cap politikası ayrı karar) |
| 50 KB cap **kastî**, hbmon `TASK-050`'de `context-economy` gerekçesiyle geçiyor | `hbmon/tasks/done/TASK-050-exit-summary.md` | cap'i yükseltmek düzeltme değil, politika gevşetmesi |
| Uyanma metni 3 yerde; core'daki `wakeMessage` üretimde ölü | `bg-tasks.ts:194-197`; `bg-wake.mjs:166,318` | NABIZ-010 |

### Yeniden değerlendirilip düşürülenler

- **Yumuşatıldı — teslimat kaydı.** Önceki okuma "teslimat durumu hiç
  kaydedilmiyor" idi. Mekanizma **ayrı süreçte** çalışıyor: `bg_run` detached
  `bg-wake.mjs` doğuruyor, o `hbmon wait` üzerinde bloklanıp `opencode run -s`
  ile enjekte ediyor; maliyet de açıkça yazılmış (*"one LLM turn per wake"*).
  Eksik olan **hesap** (başarılı mı, bastırıldı mı), mekanizma değil.
- **Düzeltilen iddia — sock kimliği.** "hbmon yalnız sock string'ine
  güveniyor, pid reuse riski var" **yanlıştı**: uuid tabanlı dosya adlandırması
  + kullanmadan önce canlılık yoklaması + ölü dosya süpürme var
  (hbmon `src/cli/mod.rs:74-171`; TASK-022/040). Alınacak fikir değil, ortak
  dil malzemesi.
- **Düzeltilen iddia — süreç-ağacı kill yok.** mcode'da **var**, kendi
  katmanında değil vendored pi'de: `third_party/pi-mono/.../shell.ts:536-568`
  `terminateProcessTreeGracefully` (grup + SIGTERM → grace → SIGKILL).
  `executor.ts:28`'deki `guardian` yorumu da tutarlıydı.
- **Düzeltilen iddia — event log yok.** Dayanıklı ve indeksli: SQLite
  `local_runtime_background_task_events` (migration v19). Persist hatası
  kasıtlı olarak ölümcül değil.

### Reddedilenler (bu depoda kapsam dışı / zaten yapılmış)

- **Soft-yield auto-background** — zaten ertelenmiş, gerekçe doğru: pi'nin
  `bash` tool'u extension'dan intercept edilemez. Değişmedi.
- **Delivery burst limiti** — zaten ertelenmiş, gerekçe doğru: 60s'de 3 turn
  onlarca task'lı cloud içindi.
- **Startup reconciliation / `lost`** — mcode'da `runtimeOwnerId` + session DB
  var; burada sidecar JSON + `adoptOrphans` var. İkisi de yeniden başlatma
  sonrası mutabakat yapıyor; mcode'un katmanlarını kopyalamak aynı işi iki
  kez uygulamak olurdu.
- **Cursor protokolü, `wait_ms` sözleşmesi, dayanıklı teslimat kaydı** —
  NABIZ-001/002/003 **zaten mcode'dan alınmış**. Tekrar önerilmedi.

### hbmon tarafına devredilenler

hbmon deposunda `TASK-055` (wait → condvar yayını) ve `TASK-056` (mutex
poisoning + yetim ağacı dürüstlüğü) açıldı; yetim ağacın sahipliği
`tasks/gap/ORPHAN-TREE-RECONCILE.md`'ye tasarım sorusu olarak bırakıldı.

Not (düzeltme): bu incelemede yukarıdaki *"(`TASK-050`)"* satırına **atıf
sürüklenmesi** diye itiraz edildi — **yanlıştı, geri alındı.** hbmon'un
`TASK-050`'si tam olarak bu koordinasyon işidir: *"Tüketici (nabız `bg_logs`)
bir task'ın ne olduğunu anlamak için bugün tüm `.out`'u (50KB cap ile)
okumak zorunda"* ve etiketi `nabiz-consumer`. Yani atıf doğru ve kasıtlı.
Kalan tek nokta: çapraz-repo atıflarda depo adı belirtilmediği için
(`TASK-050` ↔ `NABIZ-050` karışabilir) okunabilirlik için `hbmon#TASK-050`
biçimi önerilir — düzeltilecek bir hata değil, konuşma kolaylığı.
