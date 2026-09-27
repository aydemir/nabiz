#!/usr/bin/env node
// scripts/check-symlink.mjs — Windows symlink ön-kontrolü (NABIZ-006).
//
// Sorun: `npm install` workspace linklerini symlink ile kurar
// (`node_modules/nabiz-core` → `packages/core`). Windows'ta symlink yetkisi
// (SeCreateSymbolicLinkPrivilege) yoksa kurulum kriptik bir
// `EPERM: operation not permitted, symlink` ile patlar.
//
// Bu script kurulumdan ÖNCE aynı yetkiyi tmpdir'de dener: symlink kurulursa
// exit 0; EPERM olursa anlaşılır mesaj + çözümle exit 1. POSIX'te her zaman
// geçer (kontrol amaçlı çalıştırılabilir).
//
// Not: npm'in `--install-links=false` bayrağı workspaces'e etki etmez
// (npm docs: "This option has no effect on workspaces") — bu yüzden
// alternatif olarak önerilmez; yetki şarttır.
//
// Kullanım: node scripts/check-symlink.mjs

import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function main() {
  const dir = mkdtempSync(join(tmpdir(), "nabiz-symlink-check-"));
  const target = join(dir, "target.txt");
  const link = join(dir, "link");
  let code = null;
  try {
    writeFileSync(target, "x");
    symlinkSync(target, link);
    unlinkSync(link);
    console.log("ok: symlink kurulabiliyor (npm workspaces hazır)");
    return 0;
  } catch (e) {
    code = e?.code ?? String(e);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* yok say */ }
  }
  if (code === "EPERM" || code === "EACCES") {
    console.error(
      "hata: symlink yetkisi yok (npm install workspaces'te EPERM verir).\n" +
        "çözüm:\n" +
        "  1. Terminali yönetici olarak çalıştırıp tekrar dene, ya da\n" +
        "  2. Geliştirici Modu'nu aç (Ayarlar → Gizlilik ve Güvenlik → Geliştiriciler için),\n" +
        "  3. sonra: npm install && npm run build",
    );
    return 1;
  }
  console.error(`hata: symlink denemesi beklenmedik kodla düştü: ${code}`);
  return 1;
}

process.exit(main());
