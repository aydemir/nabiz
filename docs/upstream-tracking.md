# Upstream izleme — opencode v2

Bu not **ne zaman ve nereye bakılacağını** söyler. Kod yazma kararı değil;
upstream bir sürüm yayınladığında (veya plugin güncelleme/marketplace
kapsamını değiştirdiğinde) hızlıca doğrulama için.

Son doğrulama: **2026-10-05**, upstream `v2.0.22` (+ `origin/dev`).

---

## 0. ÖNCE: hangi hat? (en sık yanılan adım)

Bu repodaki `~/opencode-upstream` checkout'u **v1 hattında** (HEAD
`9a90d6f5fe`) ama `v2.0.0 .. v2.0.22` tag'lerini taşıyor. İki tuzak var:

1. **`origin/dev` v2 değil.** `git merge-base --is-ancestor` her iki yönde de
   false döner — `dev`, v2 serisinin atası değil; v2.0.22 de `dev`'in atası
   değil. `dev`'i izlemek v2'yi **hiç görmez**.
2. **v2.0.22 hiçbir remote branch'te yok.** `git branch -r --contains v2.0.22`
   boş döner. v2 serisi bu checkout'ta **tag üzerinden** erişilebilir.

### Yeni sürüm kontrolü (her seferinde çalıştır)

```bash
cd ~/opencode-upstream
git fetch --tags --quiet
git tag | grep -E '^v2\.' | sort -V | tail -5
```

### "Geliştirme hattı sonradan değişirse" kontrolü

Hattı **varsayma** — her seferinde ölç. Upstream v2'yi `dev`'e ya da yeni bir
branch'e taşıyabilir; o zaman bu notun "v1/v2 ayrı" varsayımı çürür:

```bash
# 1) v2'nin hangi commit'i? (yeni tag)
NEW=$(git rev-list -n1 v2.0.23)
# 2) dev onun atası mı? (true → v2 artık dev'e akmış)
git merge-base --is-ancestor origin/dev "$NEW" && echo "v2 -> dev'e AKMIŞ" || echo "hâlâ ayrı hat"
# 3) commit'i hangi remote branch'ler tutuyor?
git branch -r --contains "$NEW" | head
```

`v2 -> dev'e AKMIŞ` çıkarsa bu notun hat bölümünü güncelle.

**Not:** releases API'si v2.x için 404 verir — changelog için `git log` kullan,
tag'ler üzerinden oku.

---

## 1. Plugin güncelleme (upstream `ctrl+r`) — nerede

Özelliğin tamamı şu dosyalarda:

| Dosya | Ne var |
|---|---|
| `packages/core/src/plugin/update.ts` | `PluginUpdate` servisi: `check` / `update` / `changes`. 24 saat cache (`interval`), `KeyedMutex` ile target başına serialize |
| `packages/util/src/npm.ts` | `Npm.check` / `Npm.update` — asıl iş burada (`pacote` + `@npmcli/arborist`), generation klasörleri, staging, retention |
| `packages/cli/src/commands/handlers/plugin/inventory.ts` | envanter + **kapsam filtresi** (satır ~57-58) |
| `packages/cli/src/commands/handlers/plugin/add.ts` | kurulum girişi; registry/git dışını reddeder |
| `packages/cli/src/commands/handlers/plugin/check.ts` | `opencode plugin check` CLI'si |
| `packages/tui/src/config/keybind.ts` | `dialog.plugins.check` (`ctrl+r`), `.update` (`ctrl+u`), `.install` (`shift+i`) |
| `packages/tui/src/plugin/context.tsx` | `plugin.updated` event'i → sunucu plugin'larını yeniden senkronlar |
| `packages/core/src/plugin/supervisor.ts` | `source: { type: "package", target }` — hangi plugin'ın güncellenebilir sayıldığı |

### KRİTİK KISIT — updater'ın görüş alanı

`util/src/npm.ts` içindeki `parse()` **yalnızca iki target** kabul eder:

- `{ type: "registry", name, spec, mutable }` — `name@version|range|tag`
- `{ type: "git", slug, mutable }` — sabit commit değilse mutable

Başka her şey `Npm.check`'te hata verir:

```
Package checks only support registry and Git package specs
```

`inventory.ts` aynı filtreyi uygular: `isInstallablePackage()` false olan config
girdisi **envanterden tamamen düşer** — dialogda listelenmez bile. Yani **yerel
dizin yolu ve `file:` tgz kapsam dışıdır.** Bu bir bug değil, bilinçli kısıt.

Ayrıca `npm.ts`'te arborist **`ignoreScripts: true`** ile kuruyor → tüketici
tarafında `postinstall`/`prepare` **çalışmaz** (npm publish sırasında çalışır).
Bu, git-spec yolunu pahalı kılan asıl neden.

---

## 2. Marketplace — izlenecek, ama kanıt yok (2026-10-05)

Tehdit/ters-tuzak notu: adı geçiyor diye **marketplace olduğu sanılmasın**.

```bash
git grep -l marketplace v2.0.22 -- packages/core/src packages/cli/src packages/tui/src   # → BOŞ
git grep -l marketplace origin/dev -- packages/core/src packages/cli/src packages/tui/src   # → BOŞ
strings ~/.opencode/bin/opencode | grep -i marketplace                                     # → yalnız AWS SDK
```

Kurulu binary'deki tek geçiş `aws-marketplace` (AWS SDK servisi) — opencode
özelliği değil.

**KİŞİSEL ORTAM TUZAĞI:** `marketplace_inspect` / `marketplace_manage`
tool'ları ajan (orchestrator) ortamında mevcuttur, ama **opencode binary'sinde
ve hiçbir v2 sürümünde yoktur.** Aynı isim, tamamen farklı şey: ajan ortamının
paket yönetimi. Karıştırma.

Yeni sürümde grep'te **gerçek bir isim** çıkarsa (ör. `packages/core/src/marketplace/`)
o zaman bu bölümü güncelle.

---

## 3. nabız'ın hizası

Mevcut kurulum (2026-10-05):

- config `~/.config/opencode/opencode.jsonc` → `"package": "/root/.local/share/nabiz/node_modules/nabiz-opencode/plugin"` — **hâlâ mutlak yol**
- `npm view nabiz-opencode` → **1.0.0** · `npm view nabiz-core` → **1.0.0**
  (2026-10-05'te yayınlandı; hesapta `auth-and-writes` 2FA, publish `--otp` ister)
- **aktif kurulum registry değil**: `~/.local/share/nabiz/package.json`
  (`nabiz-install`, private) → `"nabiz-opencode": "file:vendor/nabiz-opencode-1.0.0.tgz"`

⇒ Paketler registry'de ama config henüz çevrilmediği için **aktif kurulum hâlâ
upstream `ctrl+r`'ın görüş alanı dışında.** Aşağıdaki config geçişi yapılınca B tamamlanır.

Karar (2026-10-05): **C → B**

- **C** — nabız kendi sürüm kontrolünü yapar. `packages/core/src/updater-notice.ts`
  (saf mantık) + `packages/harness-opencode/plugins/opencode-nabiz-updater.ts`
  (ince katman). Mevcut `file:` kurulumuna dokunmaz, upstream'e bağımlı değildir.
- **B** — `npm publish` + config `"package": "nabiz-opencode@latest"`. Upstream
  updater'ı doğrudan çalışır. **Ön koşul 2026-10-05'te sağlandı:** iki paket de
  herkese açık registry'ye yayınlandı. **Sıra önemliydi:** önce `nabiz-core@1.0.0`,
  sonra `nabiz-opencode@1.0.0` (opencode core'a bağımlı; core yoksa opencode
  kırık kurulur). **Kalan tek adım:** config'i `nabiz-opencode@latest`e çevirmek.

**Yayın tuzağı — `exports` (2026-10-05, canlı kurulumla doğrulandı):**
`Host.resolve` (`packages/plugin/src/host.ts:43`) sunucu girişini
`entry(["server", ""])` ile **önce `./server`'a** dener. `exports["./server"]`
`dist/plugins/server.js`'i gösterirse orası bir **barrel** — `export default`
yok, sadece `export { default as x }` — ve `core/src/plugin/module.ts:107`
default export zorunlu kıldığı için yükleme **başarısız** olurdu. Doğru hedef
`dist/plugin/index.js` (`export default Plugin.define(...)` olan dosya). Bugün
config dizin yolu verdiği için `path.resolve(dir, "index")` ile o dosyaya
ulaşıyordu; registry'ye geçince bu yol **değişir**. `exports` bu yüzden
`{".": "./dist/plugin/index.js", "./server": "./dist/plugin/index.js"}` olmalı.
Ayrıca `"nabiz-core": "*"` → `"^1.0.0"`: `*` registry'de yayınlanmadan
boşta bir bağımlılık bırakıyordu.

**Git-spec (A) seçilmedi:** `ignoreScripts` + `dist/`'in gitignored olması
(`.gitignore:2 packages/*/dist/`, `git ls-files .../dist` → 0 dosya) →
git'ten kurulan paket derlenmemiş gelir. `npm publish`'te `files` alanı
`dist`'i zaten kapsadığı için bu sorun B'de yok.

---

## 4. Yeni v2 sürümü çıktığında kısa kontrol listesi

1. `git fetch --tags && git tag | grep -E '^v2\.' | sort -V | tail -3` (§0)
2. Hattı ölç — hâlâ ayrı mı? (§0, "dev'e AKMIŞ" çıkarsa notu güncelle)
3. §1'deki dosyalar iki sürüm arasında değişti mi:
   `git diff v2.0.22 v2.0.23 -- packages/core/src/plugin packages/util/src/npm.ts packages/cli/src/commands/handlers/plugin packages/tui/src/config/keybind.ts`
4. `parse()` kapsamı genişledi mi? (artık `file:`/dizin de kabul ediliyor mu)
   → genişlediyse **B adımının önü kalkar**, config registry'ye dönebilir.
5. `ignoreScripts` hâlâ `true` mu?
6. Marketplace grep'i hâlâ boş mu? (§2)