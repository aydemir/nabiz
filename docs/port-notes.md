# Port notları (opencode → pi)

## API eşlemesi

| opencode (`@opencode-ai/plugin`) | pi (`@earendil-works/pi-coding-agent`) |
|---|---|
| `tool({ description, args: { x: tool.schema.string() }, execute(args) })` → `Plugin` return `{ tool: {...} }` | `pi.registerTool({ name, label, description, parameters: Type.Object({...}), execute(id, params, signal, onUpdate, ctx) })` → `{ content: [{type:"text",text}], details }` |
| `tool.schema.string().optional().describe()` | `Type.Optional(Type.String({ description }))` |
| `default export Plugin` + getLegacyPlugins kuralı | `export default function (pi: ExtensionAPI)` — sarmalayıcı yok |
| test shim'leri için `.cmd` spawn özel durumu | YOK — pi kendi spawn'ını yönetir; engine `node:child_process` execFile kullanır |

## Bilinçli kararlar (Faz 1)

1. **Runner `pi.exec` değil `execFile`**: `pi.exec` timeout semantiği belgeli değil;
   `hbmon wait` 65sn'ye kadar bloklanır. Kanıtlanmış `runHbmon` (execTimeoutMs +
   startupGrace retry + `summarizeWait`) aynen taşındı. Takip: `pi.exec` timeout'u
   doğrulanırsa engine sadeleşir.
2. **Özet cümlesi korundu**: context'e giren tek satır (`done code=0 in 38.5s`,
   `woke_on=dep_missing …`) opencode ile birebir aynı — ajan davranışı değişmez.
3. **`until` kanonik isimleri değişmez**: `done failed dep_missing timeout
   stall_suspect oom_suspect` (hbmon sözleşmesi, `HBMON-RFC.md`).
4. **Truncation**: Faz 1'de ham JSON döndürülür (opencode ile aynı). Faz 2'de
   `truncateHead`/`truncateTail` + `details` ayrımı eklenecek (pi native).

## Sıradaki portlar (öncelik sırası)

1. `hbmon_status/wait/watch` — BU FAZ.
2. MCP sunucuları (codegraph, bash-tools, bm) → `pi-mcp-adapter` üzerinden (kurulu).
3. `context-saver` + `truncation-noticer` → `tool_result` hook + truncate utility.
4. `settle-noticer` + `build-tracker` → `agent_settled` + `pi.appendEntry()`.
5. `cpu-liveness` → `tool_call`/`tool_execution_start` + `ctx.signal`.

## bg-hbmon (pi-background-tasks v2.5.0 → hbmon backend)

`extensions/bg-hbmon.ts`: upstream shell-task yüzeyinin full portu —
`bg_run/bg_status/bg_logs/bg_kill` (aynı isim/parametre/guideline),
`<background-task-notification>` XML + `customType` aynen, `notifyOnCompletion` /
`triggerOnCompletion` bayrakları ve guidance metinleri birebir. Backend upstream'in
pi-process'ine bağlı `spawn`'ı yerine hbmon daemon (`watch --detach` + 5sn
`status --compact` poll + `.jsonl` ev:`exit` fallback); çıktı upstream'in
`.pi/tasks/*.output` yerine hbmon `.out` dosyasından, aynı 50KB cap ile okunur.

Bilinçli kararlar:
- `deliverAs: 'followUp'` YOK — bu pi sürümünün `sendMessage` tipinde sadece
  `triggerTurn` var; `hbmon-bg.ts` kalıbı (`{ triggerTurn }`) kanıtlı çalışıyor.
- Message renderer YOK — runtime `@pi-tui` bağımlılığını sokmamak için bildirim
  gövdesi kendi başına yeterli (hbmon-bg.ts emsali).
- delegate / fusion / `bg_run_pi_attested` port EDİLMEDİ (child-pi orkestrasyonu,
  hbmon'la ilgisiz). `npm:pi-background-tasks` ile YAN YANA KURMA — bg_* tool
  isimleri çakışır. Aynı şekilde `hbmon-bg.ts` ile aynı anda yükleme (yerini alır).
- Doğrulama: `tsc --noEmit` temiz + canlı daemon smoke (watch/handshake,
  `status --compact` state/code, `.out` içerik, `kill`, `list` adopt şekli).

## Faz 3 — pi core'a bağlandı (2026-09-24)

`extensions/hbmon.ts`: ~180 satırlık kopya motor silindi;
`runHbmon/watchBuild/waitBuild/statusBuild` (+ `resolveHbmonBin`) artık
`nabiz-core/hbmon-tools`'tan geliyor. Kopya core'un alt kümesiydi
(win32 `.cmd` shim'i ve `watchBuild` `label` opsiyonu yalnızca core'da var) —
davranış linux'ta birebir, win32'de strictly-better. Dosya 286→106 satır;
kalan yalnızca pi sarmalayıcıları (Type şemaları + textResult + registerTool).

`extensions/bg-hbmon.ts`: özdeş 3 yardımcı core'a bağlandı —
`outFromSock` (eski `outPathFor`), `formatCursorReceipt` (makbuz metni
byte-identical), `createOffsetTracker` (tekrar takibi). Bilinçli YEREL
kalanlar: `readOffset` (dosya-yok metni ext'e özel), `mapState` (`timeout`
eşlemesi core `isTerminalState`'te yok), `exitFromLogFile` (`ev:"exit"`
filtresi core `readLastEvent`'ten farklı), `firstJsonLine`, registry
(NABIZ-002: tek-dosya `~/.pi` — core sidecar `bg-<uuid>.json` tasarımından
farklı, birleştirme ayrı karar), wait döngüsü (NABIZ-003: core'da karşılığı
yok, yalnızca `waitBuild` primitifi var).

Altyapı: root `npm install` (workspace linkleri) + `nabiz-core` build (`dist/`);
extension'lar `nabiz-core/<modül>` alt-yol importu kullanır (pakette `.`
exportu yok). `typebox` root `node_modules`'a symlinklendi (pi loader'ı
kendi çözümlemesini yapar; symlink yalnızca yerel `tsc`/test içindir,
`node_modules` gitignore'lıdır).

Doğrulama: `tsc --noEmit` (extensions, core kaynaklarına karşı) temiz +
mock-pi canlı smoke 13/13 (watch/handshake, `done code=0 in 3.5s` özeti,
status, bg_run/bg_status/bg_logs tail+cursor+tekrar, registry yazımı,
wait_ms). Beklemesiz `bg_logs` çıktıları byte-identical korundu.
