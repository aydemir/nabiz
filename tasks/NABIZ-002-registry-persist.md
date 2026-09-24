---
id: NABIZ-002
title: "Task registry persist (pi restart'ında name/notify bayrakları kaybolmasın)"
status: done
priority: P1
created: 2026-09-23
updated: 2026-09-24
labels: [bg-hbmon, durability]
depends_on: []
---

# NABIZ-002 — Task registry persist

## Amaç

`tasks` Map'i bellek-içi (`bg-hbmon.ts`); pi restart'ında task adı, notify
bayrakları ve `notified` durumu gider. hbmon tarafı daemon'da yaşadığı için
`adoptOrphans` process'i bulur ama metadata'sız bulur — bildirimler yanlış
bayrakla gider ya da hiç gitmez. Bu, hbmon'un "restart'ı atlatır" vaadini
extension katmanında boşa çıkarıyor.

İlham: minimax-code task'ları session DB'de tutar (migration
`0020-create-task-session-bindings`); registry process'e değil storage'a aittir.

## Kapsam

- Yapılacaklar
  - Registry'yi JSON dosyaya persist et (yer: pi state dizini,
    örn. `bg-hbmon-registry.json`, `0600`): `id, name, command, sock, logPath,
    outputPath, cwd, startedAt, notifyOnCompletion, triggerOnCompletion,
    notified`.
  - Her mutasyonda (run/finish/notify) atomik yaz (tmp + rename).
  - Açılışta yükle, `adoptOrphans` ile birleştir: dosyada var + hbmon'da yok
    → `failed` işaretle (socket gone); hbmon'da var + dosyada yok → adopt
    (mevcut davranış).
- Yapılmayacaklar
  - Daemon değişikliği (hbmon'a dokunulmaz).
  - Çıktı içeriğinin persist'i (`.out` zaten diskte).

## Uygulama Planı (detay — 2026-09-23)

0. **Kapsam kilidi:** persist = ÇALIŞAN task'lar. `finishTask` biteni Map'ten
   siliyor (:306-310) — bitenler registry'de yaşamaz (by design, nabız çizgisi).
   Dosya konumu GLOBAL: `~/.pi/bg-hbmon-registry.json` (sock'lar tmpdir'da global,
   `adoptOrphans` global çalışır; proje-dizini olsaydı cross-cwd adopt kırılırdı).
   `0600` explicit chmod. Homedir çözülemezse fallback `os.tmpdir()` (yeni
   `node:os` + `node:path` import'ları gerekir; `fs` zaten var :34).

1. **Serileştirme** (`bg-hbmon.ts`):
   - `toRegistry(task)`: `{ id, name, command, sock, logPath, outputPath, cwd,
     startedAt, notifyOnCompletion, triggerOnCompletion, notified }`.
     `status` YAZILMAZ — açılışta yeniden türetilir (hbmon'da yoksa
     `failed`/`socket gone`; Kapsam kuralı).
   - `saveRegistry()`: Map → JSON, atomic write (tmp + rename; yarım dosya =
     bozuk registry demektir, tolerans 2. adımdadır). Çağrı noktaları:
     `bg_run` ekleme sonrası, `finishTask` içinde `tasks.delete` SONRASI
     (dosyadan da düşer), `notifyCompletion` içinde `notified=true` sonrası
     (restart-arası çift-bildirimi engeller).
   - `loadRegistry()`: tolerant parse — bozuk/eksik dosya → `{}` + uyarı
     (widget/log), crash yok; kayıt başına şema kontrolü (`id`+`sock` string
     değilse kaydı atla, dosyayı silme).

2. **Init birleşimi** (`session_start` :477-489, `adoptOrphans` :356 ile):
   ```
   registry = loadRegistry()                       // tolerant
   live     = hbmon list (adoptOrphans'un kaynağı)  // mevcut
   registry'de var + live'da YOK → tasks.set({...reg, status:"failed",
       error:"socket gone"})                        // Kapsam kuralı
   live'da var + registry'de YOK → mevcut adopt (metadata'sız, default bayrak)
   live'da var + registry'de VAR → registry metadata'sıyla set
       (adopt'un üstüne YAZAR — sıra: önce load, sonra adopt-merge; tersi
       metadata'yı ezer)
   ```
   Sonrası mevcut akış (`tasks.size > 0` → `ensurePoller` + `refreshWidget`).
   - NABIZ-001 ile tutarlılık: cursor Map'i (`lastOffsetByTask`) persist
     KAPSAMINDA DEĞİL; restart'ta cursor sıfırlanır (NABIZ-001 planına işlendi).

3. **Eski-davranış + hata testleri** (`pi -e` deseni — repo'da framework yok):
   dosya-yok açılış (sıfırdan, mevcut gibi) → bozuk dosya (crash yok, uyarı var)
   → `bg_run sleep 60` → reload → `bg_status` ad+bayrakla listeler → süre bitince
   bildirim doğru bayrakla gider → reload sonrası ikinci bildirim YOK (notified).
   Dosya permission assert (`0600`).

**Bilinen sınırlar (dokümante, düzeltilmiyor):** iki pi instance aynı dosyaya
yazarsa last-write-wins (kilit yok — tek-kullanıcı varsayımı); başka makineden
kalmış sock `failed` işaretlenir (doğru davranış); cursor persist'i ayrı TASK
adayı (NABIZ-001'de bilinçli dışarıda).

## Etkilenen Dosyalar

- `extensions/bg-hbmon.ts` (registry load/save/init)

## Doğrulama

- `bg_run sleep 60` → extension reload (pi restart simülasyonu) → `bg_status`
  task'ı adı ve bayraklarıyla listeler → süre bitince bildirim doğru bayrakla
  gider.
- Bozuk registry dosyası ile açılış crash vermez.
