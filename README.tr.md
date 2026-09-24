# nabiz

<img src="assets/nabiz-mark.svg" width="96" alt="nabız logo">

[English](README.md) | **Türkçe**

Uzun işlerin nabzını tutar: build takibi, background task, bildirimler.
Agent sahnede çalışırken ağır işler arkada yürür, bitince haber gelir.

## Düzen

- `extensions/hbmon.ts` — uzun build takibi: `hbmon_watch` / `hbmon_wait` / `hbmon_status`
- `extensions/bg-hbmon.ts` — background task'lar: `bg_run` / `bg_status` / `bg_logs` / `bg_kill`
  + `/bg` + `/bg-status`. hbmon daemon backend'lidir; pi restart'larını atlatır.
- `.mcp.json` — MCP sunucuları (codegraph, bash, bm), lazy-load.
- `docs/port-notes.md` — iç teknik notlar.

## Kullanım

```bash
# hızlı test (kopyalamadan yükler)
pi -e /root/nabiz/extensions/hbmon.ts -p "hbmon_watch ile ['sleep','5'] çalıştır, hbmon_wait ile bekle, özeti raporla"

# kalıcı kurulum (package manifestli)
pi install /root/nabiz

# settings.json extensions listesi:
# ["/root/nabiz/extensions/hbmon.ts", "/root/nabiz/extensions/bg-hbmon.ts"]
```

## Gereksinim

- `hbmon` ikiliği (`~/.cargo/bin/hbmon` veya `PATH`'te). Bulunamazsa extension'lar
  kurulum ipucuyla döner: `cargo install hbmon`.

## Doğrulama

Gerçek `cargo build` üzerinde `watch → wait → status` akışı:
aynı handshake, aynı `woke_on` özetleri, aynı exit eşlemesi
(0 done / 1 failed / 2 dep-missing / 124 timeout / 137 oom / 3 internal).
