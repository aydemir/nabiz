# pi-harness

Pi coding agent için hbmon + yardımcı extension'lar. `opencode-plugins`'in pi karşılığı;
opencode tarafına dokunmaz, ikisini paralel yaşatır.

## Düzen

- `extensions/hbmon.ts` — uzun build takibi: `hbmon_watch` / `hbmon_wait` / `hbmon_status`
  (port kaynağı: `/root/opencode-plugins/plugins/{opencode-hbmon.ts,lib/hbmon-tools.ts}`)
- `extensions/bg-hbmon.ts` — pi-background-tasks shell-task yüzeyinin hbmon backend'li
  portu: `bg_run` / `bg_status` / `bg_logs` / `bg_kill` + `/bg` + `/bg-status`
  (kaynak: `/tmp/opencode/pi-background-tasks/package/src/`). `hbmon-bg.ts` yerine geçer,
  upstream paketle yan yana kurulmaz. Detay: `docs/port-notes.md`.
- `.mcp.json` — MCP sunucuları (codegraph, bash, bm), `pi-mcp-adapter` üzerinden
  lazy-load. Doğrulama: codegraph satır numaraları opencode ile birebir (118/149/195).
- `docs/port-notes.md` — opencode→pi port kararları

## Kullanım

```bash
# hızlı test (kopyalamadan yükler)
pi -e /root/pi-harness/extensions/hbmon.ts -p "hbmon_watch ile ['sleep','5'] çalıştır, hbmon_wait ile bekle, özeti raporla"

# kalıcı kurulum (package manifestli)
pi install /root/pi-harness

# bg-hbmon, ~/.pi/agent/extensions/hbmon-bg.ts yerine geçer — ikisini aynı anda yükleme.
# Eski dosya kaldırıldıktan sonra settings.json extensions listesi:
# ["/root/pi-harness/extensions/hbmon.ts", "/root/pi-harness/extensions/bg-hbmon.ts"]
```

## Doğrulama

Faz 1: gerçek `cargo build` üzerinde `watch → wait → status` akışı, opencode'daki
davranışla birebir (aynı handshake, aynı `woke_on` özetleri). Karşılaştırma ölçütü [docs/port-notes.md](docs/port-notes.md)'tedir.

## İlişkiler

- `hbmon` (Rust daemon, `/root/hbmon` + `~/.cargo/bin/hbmon`): değişmez, tek kaynak.
- `opencode-plugins` (`/root/opencode-plugins`): opencode tarafı yaşamaya devam eder;
  buradaki her portun karşılığı port-notes'ta listelenir, birebir silinmez.
