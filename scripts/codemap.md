# scripts/ (repo kökü)

## Responsibility
Repo düzeyi kurulum ön-kontrolü.

## Design
- `check-symlink.mjs` — Windows symlink yetkisini tmpdir'de dener;
  EPERM ise anlaşılır mesaj + exit 1 (NABIZ-006). `npm install`
  workspace linkleri symlink gerektirir.

## Integration
- Kurulumdan önce çalıştırılır; paket script'lerinden bağımsızdır.
