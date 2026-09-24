#!/usr/bin/env node
// scripts/cpu-liveness-probe/cpu-liveness-probe.js
// CPU zamanı üzerinden process liveness izleyici.
//
// NE İŞE YARAR: Verilen bir PID'in CPU zamanını periyodik olarak ölçer.
// CPU zamanı zaman içinde artıyorsa process gerçekten iş yapıyordur.
// N ardışık ölçümde artış yoksa `onStall` tetiklenir.
//
// KRİTİK SINIRLAMA: SADECE CPU-bound işler için güvenilir. CPU almamak =
// asılı kalmak DEĞİLDİR. I/O bekleme (disk okuma, network, alt-process
// bekleme, lock kontrolü) sırasında CPU alınmaz — bu `onStall` tetikler ama
// process meşru olarak yaşıyordur (FALSE POSITIVE). Tüketici bu ayrımı
// kendisi yapmalıdır: `onStall` otomatik "öldür" değildir, bir uyarıdır.
//
// PLATFORM DURUMU (doğrulama):
//   Linux   : /proc/<pid>/stat alan 14 (utime)+15 (stime) — CANLI TEST EDİLDİ.
//   macOS   : `ps -o time=` (MM:SS / HH:MM:SS) — kod yazıldı, TEST EDİLMEDİ.
//   Windows : `Get-Process -Id <pid>.TotalProcessorTime` PowerShell —
//             kod yazıldı, TEST EDİLMEDİ, çağrı maliyeti yüksek.
// Doğrulanmamış platformlarda sonuç "olası", asla "kesin" olarak ele alınmalı.
//
// İZLEME POLİTİKASI (declare — bu dosya kararın tek sahibi):
//   Default = AĞAÇ modu (includeTree: true): pid + canlı torunların CPU toplamı.
//   Gerekçe: derleme araçları işi alt process'te yapar (npm→tsc, cargo→rustc,
//   make→cc, go→compile); tek PID izleme SAĞLIKLI derlemede bile false-stall
//   üretir (Koşum 4 kanıtı). Araç-listesi-if'i YOKTUR: yeni bir derleme aracı
//   (go build vb.) kod değişmeden doğru izlenir.
//   Kökün KENDİ CPU'sunu yalnız izlemek istiyorsan includeTree: false'u AÇIKÇA
//   ver (opt-out). Sessiz default tek-PID yoktur — unutkanlık false-stall'a
//   değil, doğru davranışa düşer.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { descendants } from "./tree-kill.js";

const PLATFORM = os.platform(); // linux | darwin | win32

export const PLATFORM_VERIFIED = PLATFORM === "linux"; // macOS/Windows henüz canlı test edilmedi

// --- CPU zamanı okuyucular ---------------------------------------------------

// Linux: /proc/<pid>/stat -> alan 14 (utime) + alan 15 (stime), jiffies.
// format: pid (...) state ppid ... alan 3'ten itibaren sayılır.
// pratik güvenlik: komut adı parantezli olabilir, o yüzden son ')' sonrasından say.
function linuxCpuTime(pid) {
  // /proc doğrudan fs ile okunur: dış `cat` process'i yok, ölü PID'de stderr
  // spam'i yok (hata sessizce yukarı fırlar, watchLiveness up=null raporlar).
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = stat.lastIndexOf(")");
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  // M5-bugfix (TASK-117, kannt: `node -e "while(true){}"` 8sn'de 3 jiffies
  // okundu): ") " sonrasi fields[0] = state (alan 3) oldugundan alan N ->
  // fields[N-3] dusuyor. utime alan 14 -> fields[11], stime alan 15 ->
  // fields[12]. Eski kod fields[12]+fields[13] (stime+cutime) okuyordu;
  // saf user-space CPU tuketimi (rustc/tsc/busy-loop) FLAT gorunup
  // false-stall uretiyordu.
  const utime = Number(fields[11]) || 0;
  const stime = Number(fields[12]) || 0;
  return utime + stime; // jiffies; trend için birim önemsiz, bölme yok
}

// NOTE: Yukarıdaki dönüş değeri jiffies'dur (Linux clock tick, ~100/sn).
// Tüketici yalnızca artışı önemser, mutlak birimi değil — bu yüzden dönüş
// değerinin "hangi birimde" olduğu trend analizine etki etmez.
const linuxCpuTimeRaw = (pid) => linuxCpuTime(pid);

// macOS: `ps -o time= -p <pid>` -> "MM:SS" veya "HH:MM:SS" -> toplam saniye.
// BSD ps formatı. Canlı test edilmedi.
function darwinCpuTime(pid) {
  const out = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const parts = out.split(":").map((n) => Number(n) || 0);
  if (parts.length === 2) return parts[0] * 60 + parts[1]; // MM:SS
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]; // HH:MM:SS
  return 0;
}

// Windows: `powershell -NoProfile -Command "Get-Process -Id <pid> | Select-Object -ExpandProperty TotalProcessorTime"` -> "HH:MM:SS.fffffff"
// Canlı test edilmedi; her ölçüm yeni PowerShell işlemi açar (maliyet).
function win32CpuTime(pid) {
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).TotalProcessorTime.ToString()`],
    { encoding: "utf8" },
  ).trim();
  const parts = out.split(":").map((n) => Number(n) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

export function readCpuTime(pid) {
  switch (PLATFORM) {
    case "linux":
      return linuxCpuTimeRaw(pid);
    case "darwin":
      return darwinCpuTime(pid);
    case "win32":
      return win32CpuTime(pid);
    default:
      throw new Error(`cpu-liveness-probe: unsupported platform ${PLATFORM}`);
  }
}

// Bireysel okuyucuları da dışa ver (testler + tüketiciler için).
export const readers = { linux: linuxCpuTimeRaw, darwin: darwinCpuTime, win32: win32CpuTime };

// Tek PID okumasının sessiz sürümü: process ölmüşse null döner (fırlatmaz).
function tryReadOne(pid) {
  try {
    return readCpuTime(pid);
  } catch {
    return null;
  }
}

/**
 * readTreeCpuTime(pid): pid + o an hayatta olan tüm torunlarının CPU
 * zamanları toplamı. Derleme araçları işi neredeyse her zaman alt
 * process'lerde yapar (npm→tsc, cargo→rustc, make→cc); tek PID okuması
 * bu durumda SAĞLIKLI derlemede bile flat görünür (false stall).
 * Ölmüş torunlar toplama 0 katkıda bulunur (sessizce atlanır).
 * Kök ölmüşse null döner (tüketici up=null raporlar).
 */
export function readTreeCpuTime(pid) {
  const root = tryReadOne(pid);
  if (root === null) return null;
  let sum = root;
  for (const c of descendants(pid)) {
    const t = tryReadOne(c);
    if (t !== null) sum += t;
  }
  return sum;
}

// --- Liveness izleyici -------------------------------------------------------

/**
 * watchLiveness(pid, { intervalMs, stallThreshold, onProgress, onStall, onChange })
 *
 * pid -> izlenecek process (sayısal PID)
 * intervalMs -> iki ölçüm arası beklenen süre (ms). Not: her ölçüm bir
 *               platform okuyucu çağrısıdır; Interval aşılabilir (I/O).
 * stallThreshold -> kaç ARDIŞIK "ilerleme yok" ölçümünden sonra onStall.
 * onProgress(info) -> her ölçümde. info = { pid, at, cpuTime, delta, up }
 * onStall(info) -> eşik aşıldığında BİR KEZ. info = { pid, cpuTime, stallSamples }
 * onChange(up) -> progress/stall durum değişiminde (opsiyonel).
 *
 * Dönüş: { stop() } -> izlemeyi durdurur, onStall aday iptal edilir.
 *
 * İpucu: `delta` 0'dan büyükse process iş yapıyor (up=true). Ardışık
 * delta=0 olayları stall sayılır. Çağrı sırasına I/O gecikmesi girerse
 * takvim süresi ≠ intervalMs olabilir; yine de delta=0 takip edilir.
 *
 * `includeTree` (default TRUE) → tek PID yerine pid + canlı torunların CPU
 * toplamı (readTreeCpuTime) izlenir. `false` yalnızca kökün kendi CPU'sunu
 * istediğinde verilir (opt-out). Yapraksız process'te ağaç toplamı = tek PID
 * okumasıdır, yani default kimseyi cezalandırmaz.
 */
export function watchLiveness(pid, opts = {}) {
  const {
    intervalMs = 2000,
    stallThreshold = 3,
    onProgress = () => {},
    onStall = () => {},
    onChange = () => {},
    includeTree = true,
  } = opts;
  const read = includeTree ? readTreeCpuTime : readCpuTime;

  let last = null;
  let consecutiveZero = 0;
  let stallFired = false;
  let stopped = false;

  function sample() {
    if (stopped) return;
    let cpuTime;
    try {
      cpuTime = read(pid);
      if (cpuTime === null) throw new Error(`process ${pid} unreachable`);
    } catch (e) {
      // process öldü / erişilemez — progress info'da up=null ile raporla, durdur.
      stopped = true;
      clearInterval(timer);
      onProgress({ pid, at: Date.now(), cpuTime: null, delta: null, up: null, error: e.message });
      return;
    }

    const delta = last === null ? null : cpuTime - last;
    const up = delta !== null ? delta > 0 : true; // ilk örnek: varsayılan "ilerliyor"

    if (up) {
      consecutiveZero = 0;
      if (onChange && stallFired) onChange(true);
      stallFired = false;
    } else if (last !== null) {
      consecutiveZero += 1;
      if (!stallFired && consecutiveZero >= stallThreshold) {
        stallFired = true;
        if (onChange) onChange(false);
        onStall({ pid, cpuTime, stallSamples: consecutiveZero, at: Date.now() });
      }
    }

    last = cpuTime;
    onProgress({ pid, at: Date.now(), cpuTime, delta, up });
  }

  const timer = setInterval(sample, intervalMs);
  sample(); // ilk örnek

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    get stalled() {
      return stallFired;
    },
    get consecutiveZero() {
      return consecutiveZero;
    },
  };
}
