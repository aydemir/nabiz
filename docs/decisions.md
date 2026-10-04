# Kararlar (AGENTS.md hafıza kuralı)

> Kaynak: `opencode-plugins/docs/decisions.md` (Faz 4 arşiv taşıması,
> 2026-09-24 — working-tree haliyle birebir; history opencode-plugins
> arşivinde kalır).

Format: `[YYYY-MM-DD HH:MM] DECISION: <konu> -> <karar> | REASON:
<gerekçe> | SUPERSEDES: <önceki karar (varsa)>`

## 2026-09-10

[2026-09-10 22:05] DECISION: hbmon crates.io yayını -> stabil sürüme kadar
ertelemeli, tek kurulum kaynağı git (`cargo install --git
https://github.com/aydemir/hbmon`) | REASON: API stabil değil (watch/wait/status
sözleşmesi + event adları değişebilir); erken crates.io yayını yanlış sürüme
kilitlenen kullanıcılar + `cargo install hbmon` ad çakışması riski yaratır.
Eksik-ikilik yolları (`HBMON_INSTALL_HINT`, `docs/opencode-hbmon.md`,
`scripts/hbmon-build-mon.mjs`) git'i tek kaynak gösterir, LLM/tool da
öldürmek yerine kuruluma yönlendirir | SUPERSEDES: none

## 2026-09-11

[2026-09-11 09:15] DECISION: bash betikleri -> yasak, yeni otomasyon sadece
Node (.mjs); son .sh (`scripts/tui-live/cs-marker.sh`) `scripts/archive/`'a
taşındı, `scripts/tui-live/` kaldırıldı | REASON: bash multi-OS sorunu
(TASK-127 presedenti: build-mon/hbmon-build-mon Node portu, legacy .sh
arşivde); TASK-112 done olduğundan cs-marker'ın yaşatma maliyeti
faydasından fazla; `git mv` ile history korunur, gerekirse arşivden
çıkarılır. Referanslar arşiv yoluna güncellendi (PROJECT_MAP, AGENTS.md,
README EN/TR) | SUPERSEDES: none

## 2026-09-19

[2026-09-19 18:51] DECISION: bg-wake busy-safe adapter (`--task-id`): marker + export-poll + retry + JSONL, status-endpoint bağımlılığı yok | REASON: fork analizinde busy-drop mekanizması bulundu (Runner.ensureRunning yeni work'ü düşürür); session CLI'da status yok, HTTP status için endpoint keşfi gerekir; export `{info,messages}` + `time.created` doğrulamaya yeterli. Retry'lar aynı marker'ı taşır, denemeler injection_ts ile ayrışır. Bayraksız çağrı legacy kalır (geriye uyumlu). Test: stub opencode ile 6 satırlık matris, 14 pass/0 fail | SUPERSEDES: none

[2026-09-19 18:51] DECISION: OpenCode scheduler/fork değişikliği ertelendi (M1-M4 eşikli) | REASON: zincir idle'da çalışıyor (headless kanıt); kırılma adayı busy-drop + gözlemsizlik. Adapter önce gerçek TUI verisiyle `persistence ✓ / turn ✗` üretmeli; `✓/✓` çıkarsa müdahale gerekmez, `✗ persistence` çıkarsa sorun enjeksiyon katmanındadır. Müdahale noktaları + tetik eşikleri `docs/bg-wake-bulgular-cozumler.md` §5'te kilitli | SUPERSEDES: none

[2026-09-19 19:20] DECISION: colorMarkers workstream iptal — tüm izler kaldırıldı (ANSI + emoji restyle dahil) | REASON: 2026-09-11'de test edilip iptal edilmişti; kayda geçmemiş, 8 gün commitlenmemiş artık olarak ağaçta kalmış (her git status'ta "hortlama" izlenimi). Kapsam: plugins/lib/{prune,truncation-notice,settle-notice}.ts + 3 plugin + 3 test + 4 docs + examples + index.json KD bloğu HEAD'e alındı, plugins/lib/color-markers.ts silindi, PROJECT_MAP bölümü çıkarıldı, canlı config'ten 3 colorMarkers anahtarı temizlendi (yedek: opencode.jsonc.bak.20260919-colormarker). Marker formatları HEAD (düz metin) haline döndü | SUPERSEDES: KD-2026-09-11-color-markers

## 2026-09-25

[2026-09-25 12:00] DECISION: opencode 2.x plugin API geçişi -> V1 hook'ları
(`@opencode-ai/plugin`) V2 `Plugin.define` modeline taşındı
(`@opencode/plugin`); altı plugin `plugin/` bundle paketinde tek `nabiz`
id'si altında toplanır (hook sırası alfabetik dosya sırasıyla aynı);
seçenekler `{package, options}` + `<plugin-id>` alt-çantalarıyla verilir
(resmi şemada `pluginOptions` yoktur) | REASON: V1 dosyaları V2'de
hiç çalışmıyor (disclosure LLM'e ulaşmıyordu); `plugins` config girdisi
dosya kabul etmez ("must be a directory") — paket dizini tek yüklenebilir
birimdir; alt-çanta V1 seviyesi per-plugin kontrolü korur | SUPERSEDES: none

[2026-09-25 12:00] DECISION: MCP marka birliği -> config key + server adı
`nabiz` (tool'lar `nabiz_safe`/`nabiz_raw`); `skipTools`'ta `bash_*`
legacy alias tutulur | REASON: plugin listesi zaten `nabiz` gösteriyordu;
tek marka. Suffix kuralı + alias eski key'li kurulumları kırmaz | SUPERSEDES: none

(aşağıdaki 3 kayıt `opencode-plugins@13a0fa1:docs/decisions.md` ile birebir —
Faz 4'te kaynaktan doğrulandı; taşınan working-tree kopyasında yoktular.)

[2026-09-24 04:26] DECISION: pi harness markası -> `nabız` | REASON: pi tarafı arka plan/wakeup yüzeyinin (`bg_run` modeli + bekçi) tek adı; opencode tarafı `bg_*` tool'ları bu modelin karşılığıdır (TASK-132, `plugins/opencode-hbmon.ts`, `plugins/lib/bg-tasks.ts`, `docs/opencode-hbmon.md` zaten `pi/nabız` diye referans verir). İsim birliği: disclosure ve dokümanlarda pi tarafı `nabız`, opencode tarafı `bg_*` olarak anılır | SUPERSEDES: none

[2026-09-24 04:37] DECISION: nabız repo yapısı -> tek repo (`aydemir/nabiz`); opencode için ayrı paket, pi için ayrı paket, paylaşılan core; hbmon bağımsız repoda yaşamaya devam eder | REASON: tek marka altında çok harness (global kalıplar: `wshobson/agents` tek-kaynak + per-harness üretim, `yfge/agent-harness-skills` ince-wrapper + ortak çekirdek). Bilgi SKILL.md ile taşınır (`.agents/skills/` iki harness'te de okunur), motor (`hbmon-tools`, `bg-tasks`, `prune` — zaten host-bağımsız) core pakette paylaşılır, hook/tool/disclosure per-harness adaptörde kalır. hbmon daemon ayrı tutulur (Rust/Node toolchain kilidi) | SUPERSEDES: none

[2026-09-24 06:00] DECISION: hbmon crates.io yayını -> YAYINDA (0.2.2, 2026-09-13); birincil kurulum `cargo install hbmon` | REASON: kullanıcı talimatı + yayın zaten gerçekleşmiş (crates.io API: default_version 0.2.2). Erteleme gerekçesi (stabil-olmayan API) kullanıcı kararıyla düştü. Kurulum metinleri güncellendi (nabız: core `HBMON_INSTALL_HINT`, pi `extensions/hbmon.ts`, README EN/TR, `hbmon-build-mon.mjs`; git yolu alternatif olarak durur) | SUPERSEDES: 2026-09-10 crates.io erteleme kararı

## 2026-09-28

[2026-09-28 10:00] DECISION: OpenCode V2 tool katmanı -> plugin tool'ları core-internal Tool.make/Effect/toModelOutput ile yeniden yazılmaz; mevcut promise plugin API (ctx.tool.transform/editor.add, JSON Schema input, content string output) korunur | REASON: Tool.make core-internal (core/src/tool); plugin boot Tools.Service üzerinden canonical kayıt için henüz yeniden tasarlanmadı (current gap). Promise ToolContext alanları sessionID/agent/messageID/id/signal/progress'tir (abort/directory/worktree yok — onlar zod-helper ve core-internal adlardır); toModelOutput plugin API'sinde yok; özet cümleleri settle bounding'e zaten giriyor. "Location plugin kaydı" host işi | SUPERSEDES: dış analiz Öneri 1/2/5 (2026-09-28)

[2026-09-28 10:00] DECISION: NABIZ-006 -> done (preflight yeterli, kanıt-bar istisnası) | REASON: check-symlink.mjs EPERM'i fail-loud yakalar; CI admin runner kilitli-hesap üretemez; README çözüm yolu belgeler. EPERM dalı hiç çalışmadı — 60 satırlık script review ile kabul edildi, kilitli-hesap kanıtı opsiyonel takip (isterse NABIZ-006b P3) | SUPERSEDES: NABIZ-006 todo (kilitli-hesap bekler)

## 2026-10-04

[2026-10-04 14:05] DECISION: build komutları heap tavanıyla sınırlandı — `tsc` artık
`node --max-old-space-size=1024` ile çalışır, düşük bellekli koşullar için ayrıca
`test:lowmem` (`--test-concurrency=1`) var | REASON: sınırsız V8 tavanı bellek
kısıtlı koşullarda OOM/SIGKILL'a yol açıyor. Canlı ölçüm: her iki paketin `tsc`
derlemesi 384 MB heap tavanıyla da geçti — yani 1024 MB tavanı güvenli ve
yeterli. `NODE_OPTIONS=` prefix'i Windows cmd'de çalışmadığı için (kurulum paketi
Windows destekli, bkz NABIZ-006) node'a `--max-old-space-size` bayrağı geçirildi;
tsc her iki pakette de kökteki `node_modules/typescript` yolundan çağrılır.
Testlerde varsayılan `npm test` DEĞİŞMEDİ (paralellik korunur). opencode yüzeyi
(plugin/MCP/setup/config) hiçbir şekilde dokunulmadı — yalnız build/test komut
satırı | SUPERSEDES: none

[2026-10-04 14:05] DECISION: pi uyumluluk kapısı eklendi — `tsconfig.extensions.json`
(`npm run typecheck:ext`) + `scripts/check-pi-ext.mjs` (`npm run check:pi`),
devDep `@earendil-works/pi-coding-agent@^1.0.2` ve `typebox@^1.3.27`,
peerDependencies'e `typebox: "*"` | REASON: extension'lar daha önce HİÇ tipden
geçmiyordu ve `node_modules` pi'si 0.87.1'de kalmıştı; pi'nin güncel sürümü
1.0.2. İlk tip kontrolü gerçek bir hata buldu: `bg-hbmon.ts` içinde `fs.readFileSync`
— `fs` ad alanı hiç import edilmemiş, yol `try/catch` içinde olduğu için hata
sessizce yutulup adopt edilen arka plan işi "unknown (adopted)" olarak kayboluyordu.
`check-pi-ext.mjs` tiplerin yetmediği yerleri kapatır: pi'nin kendi jiti'siyle
yükler, `registerTool/registerCommand/on` çağrılarını sahte host'ta kaydeder,
sözleşmedeki tool/komut adlarını doğrular (canlı kanıt: pi 1.0.2, 2 extension).
pi dokümanı host paketlerinin (`pi-coding-agent`, `typebox`) `dependencies`'te
değil `peerDependencies`te `*` ile durmasını şart koşuyor | SUPERSEDES: none

[2026-10-04 14:40] DECISION: lint kapsamı tüm repo'ya açıldı — `npm run lint`
artık `oxlint .` (62 dosya, `tests/` dahil) | REASON: daraltılmış hedef listesi
`packages/*/src` + `plugins` + `plugin` + `extensions` + `scripts` idi; testler
ve `tsconfig.extensions.json` kapsam dışı kaldığı için 4 uyarı (kullanılmayan
`readFileSync` import'u, 3 `prefer-string-starts-ends-with`) görünmez halde
birikmişti. Bunlar üretim yolunu değil test yüzeyini etkiliyordu ama kapı
kapsamının kör nokta olması daha pahalı: uyarılar temizlendi (`startsWith`,
ölü import silindi) ve kapı genişletildi. Prettier kapsamı değişmedi | SUPERSEDES: none

[2026-10-04 14:55] DECISION: prettier gürültüsü sıfırlandı — `npm run format`
kapsamındaki 4 dosya (hbmon-tools.ts, bg-wake.mjs, setup.test.mjs,
tool-context.test.mjs) yeniden sarıldı | REASON: uyarılar yalnız satır
genişliği kaynaklıydı (120 sütun taşması: inline tip nesnesi, uzun ternary,
argüman listesi) — anlamsal değişiklik yok; `format:check` artık tüm
kapsamda temiz, dolayısıyla kapılar (build/lint/typecheck/pi-check/test)
tek komutla yeşil | SUPERSEDES: none
