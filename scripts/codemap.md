# scripts/ (repo kökü)

## Responsibility
Repo düzeyi kurulum ön-kontrolü ve pi uyumluluk kapısı.

## Design
- `check-symlink.mjs` — Windows symlink yetkisini tmpdir'de dener;
  EPERM ise anlaşılır mesaj + exit 1 (NABIZ-006). `npm install`
  workspace linkleri symlink gerektirir.
- `check-pi-ext.mjs` — pi uyumluluk kapısı (`npm run check:pi`): pi'nin
  KENDİ jiti'siyle `extensions/*.ts` dosyalarını yükler, `default` factory'leri
  sahte `pi` stub'ıyla çağırır (yalnız `registerTool`/`registerCommand`/`on`
  kaydeder; TUI/agent bağımlılığı olan yollar çalıştırılmaz), sözleşmedeki
  tool/komut adlarını doğrular. `tsc` temiz olsa bile kaldırılan runtime
  API'sini yalnız yükleme yakalar — pi güncellenince bu kapı nabız'ın
  kırılmadığını gösterir. Çıkış: 0=tamam, 1=yükleme/şema hatası.

## Integration
- `check-symlink.mjs` kurulumdan önce çalıştırılır; paket script'lerinden bağımsızdır.
- `check-pi-ext.mjs` `npm run typecheck:ext` ile birlikte çalıştırılır; ikisi de
  yalnız `extensions/` yüzeyine bakar, opencode paketlerine dokunmaz.
