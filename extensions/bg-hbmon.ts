/**
 * bg-hbmon — pi-background-tasks (v2.6.0, ismailsaleekh) shell-task yüzeyinin
 * hbmon daemon backend'li full portu.
 *
 * v2.6.1: renkli TUI renderer kaldırıldı (eski sade görünüme dönüş).
 * Bildirim düz <background-task-notification> XML + customType olarak akar.
 * Toast seviyesi korunur: completed→info, killed→warning, failed→error.
 *
 *
 * Ne port edildi (kullanıcı-görünür sözleşme birebir):
 * - Tool'lar: bg_run / bg_status / bg_logs / bg_kill (aynı isim, aynı parametreler,
 *   aynı promptGuidelines, aynı "polling YOK" disiplini).
 * - Bildirim: <background-task-notification> XML gövdesi + customType aynen
 *   'background-task-notification'; notifyOnCompletion / triggerOnCompletion
 *   bayrakları ve deriveCompletionDeliveryGuidance metinleri upstream ile aynı.
 * - Komutlar: /bg ve /bg-status (hbmon-bg.ts'ten devralındı).
 *
 * Ne port EDİLMEDİ (bilinçli): delegate / fusion / bg_run_pi_attested / TUI dock.
 * Bunlar child-pi orkestrasyonu; hbmon'la ilgisiz. Gerekirse upstream paket
 * (`pi install npm:pi-background-tasks`) yan yana kurulur — ama bg_run/bg_status/
 * bg_logs/bg_kill ÇAKIŞIR; ikisini aynı anda yükleme (bu dosya shell-task'ların
 * yerine geçenidir).
 *
 * Backend farkı (neden hbmon): upstream node:child_process spawn'u pi process'ine
 * bağlıdır (restart'ta registry hafızası gider); hbmon daemon harness-bağımsızdır,
 * pi restart'larını atlatır, çıkış durumu .jsonl'deki ev:"exit" satırında durur.
 * Çıktı: hbmon'un .out dosyası (upstream'in .pi/tasks/*.output karşılığı),
 * bg_logs aynı 50KB cap ile oradan okur.
 *
 * Yükleme: pi -e /root/nabiz/extensions/bg-hbmon.ts
 * (hbmon-bg.ts ile AYNI ANDA yükleme — bu dosya onun yerini alır.)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// Faz 3: host-bağımsız yardımcılar nabiz-core/bg-tasks'tan.
// Yerel kalanlar (bilinçli): readOffset (dosya-yok metni ext'e özel),
// mapState (timeout eşlemesi core'da yok), exitFromLogFile (ev:exit filtresi
// core readLastEvent'ten farklı), firstJsonLine, registry (NABIZ-002:
// tek-dosya ~/.pi — core sidecar tasarımından farklı), wait döngüsü (NABIZ-003).
import {
  createOffsetTracker,
  formatCursorReceipt,
  outFromSock,
  type OffsetTracker,
} from "nabiz-core/bg-tasks";

// --- upstream common.ts'tan aynen alınan sabitler/yardımcılar ---

const MAX_LOG_BYTES = 50 * 1024;
const DEFAULT_LOG_BYTES = 50 * 1024;

function truncateChars(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function stripMatchingQuotes(value: string): string {
	const t = value.trim();
	if (t.length >= 2) {
		const f = t[0];
		const l = t[t.length - 1];
		if ((f === '"' || f === "'") && f === l) return t.slice(1, -1).trim();
	}
	return t;
}

function normalizeTaskName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const n = compactWhitespace(stripMatchingQuotes(value));
	if (!n) return undefined;
	return truncateChars(n, 80);
}

function deriveTaskNameFromCommand(command: string): string {
	const normalized = compactWhitespace(stripMatchingQuotes(command));
	if (!normalized) return "Background task";
	const m = /^(npm|pnpm|yarn|bun)\s+(?:(run)\s+)?([^\s;&|]+)/.exec(normalized);
	if (m) {
		const runner = m[1] ?? "npm";
		const run = m[2] !== undefined ? " run" : "";
		const script = m[3] ?? "";
		return truncateChars(`${runner}${run} ${script}`, 48);
	}
	const words = normalized.split(/\s+/).slice(0, 5).join(" ");
	return truncateChars(words.length > 0 ? words : normalized, 48);
}

function taskDisplayName(t: { name?: string; description?: string; command?: string; id?: string }): string {
	const cmd = t.command && t.command.length > 0 ? deriveTaskNameFromCommand(t.command) : undefined;
	return normalizeTaskName(t.name) ?? normalizeTaskName(t.description) ?? cmd ?? t.id ?? "Background task";
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** upstream deriveCompletionDeliveryGuidance — metinler aynen korundu. */
function completionGuidance(notify: boolean, trigger: boolean): string {
	if (notify && trigger) {
		return [
			"Terminal notification: enabled.",
			"Automatic follow-up turn: enabled.",
			"Next action: do not poll or sleep merely to wait; continue only independent useful work, otherwise end this turn and wait for <background-task-notification>.",
		].join("\n");
	}
	if (notify) {
		return [
			"Terminal notification: enabled.",
			"Automatic follow-up turn: disabled. The terminal notification will be delivered, but it will not start an agent turn.",
			"Next action: automatic wake-up was explicitly disabled; use bg_status/bg_logs only when deliberate monitoring is required, without tight polling.",
		].join("\n");
	}
	return [
		"Terminal notification: disabled.",
		trigger
			? "Automatic follow-up turn: disabled because terminal notifications are disabled. triggerOnCompletion has no effect while notifyOnCompletion is false."
			: "Automatic follow-up turn: disabled.",
		"Next action: completion delivery was explicitly disabled; use bg_status/bg_logs only for deliberate manual monitoring, without tight polling.",
	].join("\n");
}

// --- hbmon destekli task modeli ---

type HbTaskStatus = "running" | "completed" | "failed" | "killed";

interface HbTask {
	id: string; // hbmon uuid
	name: string;
	command: string;
	description?: string;
	isAgent: boolean;
	status: HbTaskStatus;
	exitCode: number | null;
	error?: string;
	sock: string;
	logPath: string; // .jsonl (exit event)
	outputPath: string; // .out (ham stdout/stderr)
	cwd: string;
	startedAt: number;
	pid?: number;
	notified: boolean;
	notifyOnCompletion: boolean;
	triggerOnCompletion: boolean;
	misses: number;
}

const POLL_MS = Number(process.env.HBMON_BG_POLL_MS ?? 5000);
const MAX_MISSES = 12;

const EXIT_HINT: Record<string, string> = {
	completed: "continue",
	failed: "read the bounded logs below, fix, retry",
	killed: "task was stopped, inspect and decide",
};

const tasks = new Map<string, HbTask>();
// NABIZ-001 tekrar tespiti: saklanan İSTENEN offset'tir (nextOffset değil).
// Bellekte tutulur (bilinçli: cursor NABIZ-002 persist KAPSAMINDA DEĞİL;
// restart'ta sıfırlanır); biten task'ta silinir. Motor core'dan.
const offsetTracker: OffsetTracker = createOffsetTracker();
let pollTimer: ReturnType<typeof setInterval> | undefined;
let uiRef: ExtensionContext["ui"] | undefined;
let currentCtx: ExtensionContext | undefined;

// --- NABIZ-002 registry persist (restart durability) ---
// Konum GLOBAL: ~/.pi/bg-hbmon-registry.json (sock'lar tmpdir'da global,
// adoptOrphans global çalışır; proje-dizini olsaydı cross-cwd adopt kırılırdı).
// Homedir çözülemezse fallback os.tmpdir(). Dosya 0600, yazım atomik (tmp+rename).
// Persist = ÇALIŞAN task'lar; bitenler finishTask ile Map'ten + dosyadan düşer.
// status YAZILMAZ — açılışta yeniden türetilir (hbmon'da yoksa failed/socket gone).

interface RegistryEntry {
	id: string;
	name: string;
	command: string;
	sock: string;
	logPath: string;
	outputPath: string;
	cwd: string;
	startedAt: number;
	notifyOnCompletion: boolean;
	triggerOnCompletion: boolean;
	notified: boolean;
}

function registryPath(): string {
	try {
		const home = os.homedir();
		if (home) return path.join(home, ".pi", "bg-hbmon-registry.json");
	} catch {
		// fallback aşağıda
	}
	return path.join(os.tmpdir(), "bg-hbmon-registry.json");
}

function toRegistry(t: HbTask): RegistryEntry {
	return {
		id: t.id,
		name: t.name,
		command: t.command,
		sock: t.sock,
		logPath: t.logPath,
		outputPath: t.outputPath,
		cwd: t.cwd,
		startedAt: t.startedAt,
		notifyOnCompletion: t.notifyOnCompletion,
		triggerOnCompletion: t.triggerOnCompletion,
		notified: t.notified,
	};
}

function saveRegistry(): void {
	try {
		const file = registryPath();
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
		} catch {
			// dizin zaten var
		}
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify([...tasks.values()].map(toRegistry), null, 2), "utf-8");
		try {
			fs.chmodSync(tmp, 0o600);
		} catch {
			// chmod desteklenmiyorsa devam
		}
		fs.renameSync(tmp, file);
		try {
			fs.chmodSync(file, 0o600);
		} catch {
			// best-effort
		}
	} catch {
		// persist best-effort — bellek-içi Map her zaman doğruluk kaynağı
	}
}

function isRegistryEntry(v: any): v is RegistryEntry {
	return (
		!!v &&
		typeof v.id === "string" &&
		typeof v.sock === "string" &&
		typeof v.name === "string" &&
		typeof v.command === "string" &&
		typeof v.logPath === "string" &&
		typeof v.outputPath === "string" &&
		typeof v.cwd === "string" &&
		typeof v.startedAt === "number"
	);
}

/** Tolerant yükleme: bozuk/eksik dosya → boş Map + uyarı yok (crash asla yok). */
function loadRegistry(): Map<string, RegistryEntry> {
	const out = new Map<string, RegistryEntry>();
	let raw: string;
	try {
		raw = fs.readFileSync(registryPath(), "utf-8");
	} catch {
		return out; // dosya yok — sıfırdan açılış
	}
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return out; // bozuk dosya — crash yok
	}
	if (!Array.isArray(parsed)) return out;
	for (const e of parsed) {
		if (!isRegistryEntry(e)) continue; // kaydı atla, dosyayı silme
		out.set(e.id, {
			id: e.id,
			name: e.name,
			command: e.command,
			sock: e.sock,
			logPath: e.logPath,
			outputPath: e.outputPath,
			cwd: e.cwd,
			startedAt: e.startedAt,
			notifyOnCompletion: e.notifyOnCompletion ?? true,
			triggerOnCompletion: e.triggerOnCompletion ?? true,
			notified: e.notified ?? false,
		});
	}
	return out;
}

function shortId(id: string): string {
	return id.slice(0, 8);
}

// (outPathFor → core outFromSock; davranış aynı: .sock→.out)

function snapshot(t: HbTask) {
	return {
		id: t.id,
		name: t.name,
		command: t.command,
		status: t.status,
		exitCode: t.exitCode,
		error: t.error,
		outputPath: t.outputPath,
		cwd: t.cwd,
		isAgent: t.isAgent,
		notifyOnCompletion: t.notifyOnCompletion,
		triggerOnCompletion: t.triggerOnCompletion,
	};
}

function resolveTask(idOrPrefix: string): HbTask {
	const exact = tasks.get(idOrPrefix);
	if (exact) return exact;
	const cands = [...tasks.values()].filter((t) => t.id.startsWith(idOrPrefix));
	if (cands.length === 1) return cands[0] as HbTask;
	if (cands.length === 0) throw new Error(`Unknown background task: ${idOrPrefix}`);
	throw new Error(`Ambiguous task prefix: ${idOrPrefix} (${cands.length} matches)`);
}

function firstJsonLine(stdout: string): any {
	const line = stdout
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean)[0];
	if (!line) throw new Error("empty output");
	return JSON.parse(line);
}

/** .jsonl'deki son ev:"exit" satırı — tüm log asla okunmaz. */
function exitFromLogFile(logPath: string): { state: string; code: number } | undefined {
	try {
		const lines = fs.readFileSync(logPath, "utf-8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = (lines[i] as string).trim();
			if (!line) continue;
			try {
				const ev = JSON.parse(line);
				if (ev && ev.ev === "exit") {
					return { state: String(ev.state ?? "done"), code: Number(ev.code ?? 0) };
				}
			} catch {
				// JSON olmayan satırları atla
			}
		}
	} catch {
		// log dosyası yok
	}
	return undefined;
}

/** hbmon state → upstream TaskStatus eşlemesi. */
function mapState(state: string, code: number): { status: HbTaskStatus; error?: string } {
	if (state === "done") return { status: "completed" };
	if (state === "failed") return { status: "failed" };
	if (state === "dep_missing") return { status: "failed", error: "dependency missing (install it, retry)" };
	if (state === "timeout") return { status: "failed", error: `timeout (exit ${code})` };
	return { status: "failed", error: `unknown terminal state: ${state}` };
}

function refreshWidget(): void {
	if (!uiRef) return;
	try {
		if (tasks.size === 0) {
			uiRef.setWidget("bg-hbmon", undefined);
			uiRef.setStatus("bg-hbmon", undefined);
			return;
		}
		const running = [...tasks.values()].filter((t) => t.status === "running").length;
		const lines = [...tasks.values()].map((t) => {
			const s = Math.round((Date.now() - t.startedAt) / 1000);
			return `bg ${shortId(t.id)} [${t.status}] ${s}s :: ${taskDisplayName(t)}`;
		});
		uiRef.setWidget("bg-hbmon", lines);
		uiRef.setStatus("bg-hbmon", ` bg ${running} running `);
	} catch {
		// UI yok — poller çalışmaya devam eder
	}
}

function formatSnapshotList(all: HbTask[]): string {
	if (all.length === 0) return "No background tasks.";
	return all
		.map((t) => {
			const s = Math.round((Date.now() - t.startedAt) / 1000);
			return `- ${taskDisplayName(t)} (${shortId(t.id)}) [${t.status}] ${s}s exit=${t.exitCode ?? "?"} out=${t.outputPath}`;
		})
		.join("\n");
}

async function notifyCompletion(pi: ExtensionAPI, task: HbTask): Promise<void> {
	if (!task.notifyOnCompletion || task.notified) return;
	task.notified = true;
	saveRegistry(); // restart-arası çift-bildirimi engeller
	const secs = Math.round((Date.now() - task.startedAt) / 1000);
	const name = taskDisplayName(task);
	const guidance =
		"Terminal state and output metadata are durable. Do not call bg_status to reconfirm; use bg_logs only if output is needed.";
	const content = [
		"<background-task-notification>",
		`  <task-id>${task.id}</task-id>`,
		`  <task-name>${escapeXml(name)}</task-name>`,
		`  <status>${task.status}</status>`,
		task.exitCode === null || task.exitCode === undefined
			? ""
			: `  <exit-code>${String(task.exitCode)}</exit-code>`,
		task.error ? `  <error>${escapeXml(task.error)}</error>` : "",
		`  <output-file>${escapeXml(task.outputPath)}</output-file>`,
		`  <summary>${escapeXml(`Background task ${JSON.stringify(name)} ${task.status}`)}</summary>`,
		`  <guidance>${escapeXml(guidance)}</guidance>`,
		"</background-task-notification>",
	]
		.filter(Boolean)
		.join("\n");
	try {
		const level = task.status === "completed" ? "info" : task.status === "killed" ? "warning" : "error";
		uiRef?.notify(`bg: ${name} → ${task.status} (exit ${task.exitCode ?? "?"}, ${secs}s)`, level);
	} catch {
		// UI yok — aşağıdaki mesaj yine ulaşır
	}
	// hbmon-bg.ts kanıtlı kalıbı: triggerTurn LLM'i uyandırır (bu pi sürümünde
	// deliverAs yok; upstream'deki { deliverAs:'followUp' } atlanır).
	pi.sendMessage(
		{ customType: "background-task-notification", content, display: true, details: snapshot(task) },
		{ triggerTurn: task.triggerOnCompletion },
	);
}

async function finishTask(pi: ExtensionAPI, task: HbTask, status: HbTaskStatus, code: number | null, error?: string): Promise<void> {
	task.status = status;
	task.exitCode = code;
	if (error !== undefined) task.error = error;
	tasks.delete(task.id);
	offsetTracker.forget(task.id);
	saveRegistry(); // biten registry'den de düşer
	refreshWidget();
	const hint = EXIT_HINT[status] ?? "inspect and decide";
	await notifyCompletion(pi, task);
	// notify kapalıysa bile en azından ipucu içerikte kalsın diye log'a not düşülmez;
	// ajan bg_status ile görebilir. Bitmiş task map'ten silindiği için ayrıca:
	void hint;
}

async function pollOnce(pi: ExtensionAPI): Promise<void> {
	for (const task of [...tasks.values()]) {
		let res;
		try {
			res = await pi.exec("hbmon", ["status", "--sock", task.sock, "--compact"], { timeout: 10_000 });
		} catch {
			task.misses += 1;
			continue;
		}
		if (res.code !== 0) {
			// Stale sock = daemon temizlendi; sonucu .jsonl'deki exit event'ten oku.
			const exit = exitFromLogFile(task.logPath);
			if (exit) {
				const m = mapState(exit.state, exit.code);
				await finishTask(pi, task, m.status, exit.code, m.error);
			} else if ((res.stderr ?? "").includes("No such file") && (task.misses += 1) > MAX_MISSES) {
				await finishTask(pi, task, "failed", -1, "socket gone, no exit event in log");
			}
			continue;
		}
		task.misses = 0;
		let st: any;
		try {
			st = JSON.parse(res.stdout);
		} catch {
			continue;
		}
		const state = String(st.state ?? "unknown");
		const code = Number(st.code ?? -1);
		if (["done", "failed", "dep_missing", "timeout"].includes(state)) {
			const m = mapState(state, code);
			await finishTask(pi, task, m.status, code, m.error);
		}
	}
	refreshWidget();
}

async function adoptOrphans(pi: ExtensionAPI, reg?: Map<string, RegistryEntry>): Promise<number> {
	let out;
	try {
		out = await pi.exec("hbmon", ["list"], { timeout: 10_000 });
	} catch {
		return 0;
	}
	if (out.code !== 0) return 0;
	let entries: any;
	try {
		entries = JSON.parse(out.stdout);
	} catch {
		return 0;
	}
	if (!Array.isArray(entries)) return 0;
	let added = 0;
	for (const e of entries) {
		if (!e || e.live === false) continue;
		const uuid = String(e.uuid ?? "");
		if (!uuid || tasks.has(uuid)) continue;
		const sock = String(e.sock ?? `/tmp/hbmon-${uuid}.sock`);
		if (!fs.existsSync(sock)) continue;
		const log = sock.replace(/\.sock$/, ".jsonl");
		let cmd = "unknown (adopted)";
		let startedAt = Date.now();
		try {
			const first = fs
				.readFileSync(log, "utf-8")
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean)[0];
			if (first) {
				const ready = JSON.parse(first as string);
				if (ready.cmd) cmd = String(ready.cmd);
				if (ready.ts) {
					const t = Date.parse(ready.ts);
					if (!Number.isNaN(t)) startedAt = t;
				}
			}
		} catch {
			// varsayılanlar
		}
		const saved = reg?.get(uuid);
		if (saved) {
			// live + registry VAR → registry metadata'sıyla set (adopt'un üstüne YAZAR)
			tasks.set(uuid, {
				id: uuid,
				name: saved.name,
				command: saved.command,
				isAgent: false,
				status: "running",
				exitCode: null,
				sock: saved.sock,
				logPath: saved.logPath,
				outputPath: saved.outputPath,
				cwd: saved.cwd,
				startedAt: saved.startedAt,
				notified: saved.notified,
				notifyOnCompletion: saved.notifyOnCompletion,
				triggerOnCompletion: saved.triggerOnCompletion,
				misses: 0,
			});
			added += 1;
			continue;
		}
		tasks.set(uuid, {
			id: uuid,
			name: deriveTaskNameFromCommand(cmd),
			command: cmd,
			isAgent: false,
			status: "running",
			exitCode: null,
			sock,
			logPath: log,
			outputPath: outFromSock(sock),
			cwd: currentCtx?.cwd ?? process.cwd(),
			startedAt,
			notified: false,
			notifyOnCompletion: true,
			triggerOnCompletion: true,
			misses: 0,
		});
		added += 1;
	}
	return added;
}

function ensurePoller(pi: ExtensionAPI): void {
	if (pollTimer) return;
	pollTimer = setInterval(() => {
		pollOnce(pi).catch(() => {
			// poll hatası timer'ı öldürmez
		});
	}, POLL_MS);
}

function readBounded(outputPath: string, maxBytes: number, tail: boolean): { text: string; bytesRead: number; truncated: boolean } {
	const st = fs.statSync(outputPath);
	const size = st.size;
	if (size <= maxBytes) {
		return { text: fs.readFileSync(outputPath, "utf-8"), bytesRead: size, truncated: false };
	}
	const fd = fs.openSync(outputPath, "r");
	try {
		const buf = Buffer.alloc(maxBytes);
		const pos = tail ? Math.max(0, size - maxBytes) : 0;
		fs.readSync(fd, buf, 0, maxBytes, pos);
		return { text: buf.toString("utf-8"), bytesRead: maxBytes, truncated: true };
	} finally {
		fs.closeSync(fd);
	}
}

// NABIZ-001 cursor okuma (readBounded YANINA — mevcut fonksiyona dokunulmadı).
// Aralık [offset, offset+maxBytes); nextOffset = offset + okunan.
// offset > size → cursor EOF'a sabitlenir. Negatif/NaN → 0. UTF-8 kesimi as-is.
function readOffset(outputPath: string, offset: number, maxBytes: number): { text: string; nextOffset: number; size: number; truncated: boolean } {
	const size = fs.statSync(outputPath).size;
	let off = Number.isFinite(offset) ? Math.floor(offset) : 0;
	if (off < 0) off = 0;
	if (off > size) return { text: "", nextOffset: size, size, truncated: false };
	const n = Math.min(maxBytes, size - off);
	const fd = fs.openSync(outputPath, "r");
	try {
		const buf = Buffer.alloc(n);
		fs.readSync(fd, buf, 0, n, off);
		const nextOffset = off + n;
		return { text: buf.toString("utf-8"), nextOffset, size, truncated: nextOffset < size };
	} finally {
		fs.closeSync(fd);
	}
}

// --- NABIZ-003 bloklayan okuma (hbmon wait reuse) ---
// Daemon wait'i terminal durumda uyandırır ama yeni çıktıda UYANMAZ
// (kanıt: 24.09 — MERHABA çıktısına rağmen 12s timeout). Bu yüzden dilimli
// bekleme: her dilim daemon'da bloklanır (busy-poll YOK), dilim aralarında
// .out büyümesi kontrol edilir → yeni bayt/terminalde erken dön.

const WAIT_CAP_MS = 30000;
const WAIT_SLICE_MS = 2000;

function outFileSize(outputPath: string): number | undefined {
	try {
		return fs.statSync(outputPath).size;
	} catch {
		return undefined; // henüz çıktı yok
	}
}

/**
 * Tek task için hafif terminal tazeleme (bg_logs içi — salt-görünüm).
 * pollOnce'tan farklı: silme/bildirim/persist YOK, yalnızca status/exitCode
 * alanları güncellenir. Dönüş: terminal mi?
 */
async function refreshOneTask(pi: ExtensionAPI, task: HbTask): Promise<boolean> {
	let res;
	try {
		res = await pi.exec("hbmon", ["status", "--sock", task.sock, "--compact"], { timeout: 10_000 });
	} catch {
		res = undefined;
	}
	if (res && res.code === 0) {
		try {
			const st = JSON.parse(res.stdout);
			const state = String(st.state ?? "unknown");
			const code = Number(st.code ?? -1);
			if (["done", "failed", "dep_missing", "timeout"].includes(state)) {
				const m = mapState(state, code);
				task.status = m.status;
				task.exitCode = code;
				if (m.error !== undefined) task.error = m.error;
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}
	// Stale sock → .jsonl'deki exit event'e bak (poller finish'i devralır).
	const exit = exitFromLogFile(task.logPath);
	if (exit) {
		const m = mapState(exit.state, exit.code);
		task.status = m.status;
		task.exitCode = exit.code;
		if (m.error !== undefined) task.error = m.error;
		return true;
	}
	return false;
}

// --- tool parametreleri (upstream ile aynı) ---

const BgRunParams = Type.Object({
	name: Type.String({ description: "Short human-readable task name shown in the bg footer dock. Required; use 2-6 words, not the raw command." }),
	command: Type.String({ description: "Shell command to start in the background" }),
	isAgent: Type.Boolean({ description: "Required. Set true only when this background task launches an LLM/agent process. Set false for scripts, tests, servers, sleeps, and ordinary shell commands." }),
	description: Type.Optional(Type.String({ description: "Optional longer human-readable context for the task" })),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Optional timeout; task is failed and killed when exceeded" })),
	notifyOnCompletion: Type.Optional(Type.Boolean({ description: "Whether to deliver the durable terminal notification. Default: true." })),
	triggerOnCompletion: Type.Optional(Type.Boolean({ description: "Whether that notification should automatically trigger a follow-up agent turn. Default: true; requires notifyOnCompletion." })),
});

const BgStatusParams = Type.Object({
	taskId: Type.Optional(Type.String({ description: "Optional task ID or unambiguous prefix. If omitted, all running/recent tasks are returned." })),
});

const BgLogsParams = Type.Object({
	taskId: Type.String({ description: "Task ID or unambiguous prefix" }),
	maxBytes: Type.Optional(Type.Number({ description: `Maximum bytes to return, capped at ${formatSize(MAX_LOG_BYTES)}. Default: ${formatSize(DEFAULT_LOG_BYTES)}.` })),
	tail: Type.Optional(Type.Boolean({ description: "Read the tail of the log when true, head when false. Default: true." })),
	offset: Type.Optional(Type.Number({ description: "Artımlı okuma bayt konumu (önceki yanıtın next_offset'i; yoksa tail modu)" })),
	wait_ms: Type.Optional(Type.Number({ description: "Bloklayan okuma: yeni çıktı veya terminal durum gelene kadar en fazla bu kadar ms bekle (cap 30000, aşım kırpılır). Mevcut çıktı/terminal varsa hemen döner. Vermezsen/0 ise beklemez." })),
});

const BgKillParams = Type.Object({
	taskId: Type.String({ description: "Task ID or unambiguous prefix to stop" }),
});

function textResult(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx as ExtensionContext;
		if ((ctx as ExtensionContext).hasUI) uiRef = (ctx as ExtensionContext).ui;
		// NABIZ-002 init birleşimi: önce registry yükle (tolerant), sonra adopt-merge.
		// Sıra önemli — tersi registry metadata'sını ezer.
		const reg = loadRegistry();
		try {
			await adoptOrphans(pi, reg);
		} catch {
			// best-effort
		}
		// registry'de var + live'da YOK → failed/socket gone (poller temizler)
		for (const r of reg.values()) {
			if (tasks.has(r.id)) continue;
			tasks.set(r.id, {
				id: r.id,
				name: r.name,
				command: r.command,
				isAgent: false,
				status: "failed",
				exitCode: -1,
				error: "socket gone",
				sock: r.sock,
				logPath: r.logPath,
				outputPath: r.outputPath,
				cwd: r.cwd,
				startedAt: r.startedAt,
				notified: r.notified,
				notifyOnCompletion: r.notifyOnCompletion,
				triggerOnCompletion: r.triggerOnCompletion,
				misses: MAX_MISSES,
			});
		}
		if (tasks.size > 0) {
			saveRegistry(); // adopt edilen + failed işaretlenen haliyle yaz
			ensurePoller(pi);
			refreshWidget();
		}
	});

	pi.on("session_shutdown", async () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		try {
			uiRef?.setWidget("bg-hbmon", undefined);
			uiRef?.setStatus("bg-hbmon", undefined);
		} catch {
			// kapanış — yoksay
		}
		// Job'lar yaşar: hbmon daemon harness-bağımsızdır; sonraki
		// session_start'ta adoptOrphans ile geri alınırlar.
	});

	pi.registerTool({
		name: "bg_run",
		label: "Background Run",
		description: `Start a named long-running shell command in the background and return immediately with a task ID and output path. By default, completed/failed/killed terminal state is delivered automatically as <background-task-notification> and starts a follow-up agent turn; do not sleep or poll merely to wait. Output is written to the hbmon .out file and model-visible logs are bounded to ${formatSize(MAX_LOG_BYTES)}.`,
		promptSnippet: "Start a named long-running shell command; default terminal notification wakes a follow-up turn, so yield instead of polling",
		promptGuidelines: [
			"Use bg_run instead of bash for commands expected to run for a long time, such as test suites, dev servers, watchers, or builds.",
			"Always set isAgent: true only when the background task launches an LLM/agent process; set isAgent: false for scripts, tests, dev servers, sleeps, and ordinary shell commands.",
			"When using bg_run, always set name to a concise 2-6 word human-readable label for the footer task dock; do not use the raw command as the name unless it is already short and meaningful.",
			"bg_run returns immediately. With notifyOnCompletion:true and triggerOnCompletion:true (both defaults), completed, failed, or killed terminal state is delivered as <background-task-notification> and automatically starts a follow-up agent turn.",
			"After a default bg_run launch, continue only independent useful work that does not merely wait for the task; otherwise briefly acknowledge it if useful, then end the current turn. Do not call sleep, bg_status, or bg_logs merely to wait; the terminal notification will wake you.",
			"Treat <background-task-notification> as durable terminal truth. Do not call bg_status to reconfirm it; call bg_logs only when the task output is needed.",
			"Use bg_status/bg_logs only when the user explicitly requests an update, automatic notification or wake-up was deliberately disabled, there is concrete evidence the task is hung, or a terminal notification arrived and output details are needed.",
			"Do not set notifyOnCompletion:false or triggerOnCompletion:false unless intentionally opting out of automatic completion handling.",
		],
		parameters: BgRunParams,
		async execute(_id, params: any, _signal: any, _onUpdate: any, ctx: any) {
			if (typeof params.command !== "string") throw new Error("bg_run requires command string");
			if (typeof params.isAgent !== "boolean") {
				throw new Error("bg_run requires isAgent boolean. Set true only for LLM/agent tasks; set false for scripts, tests, servers, sleeps, and ordinary shell commands.");
			}
			const name = normalizeTaskName(params.name) ?? deriveTaskNameFromCommand(params.command);
			const notify = params.notifyOnCompletion ?? true;
			const trigger = params.triggerOnCompletion ?? true;
			const args = ["watch", "--detach"];
			if (typeof params.timeoutSeconds === "number") args.push("--timeout-sec", String(params.timeoutSeconds));
			// Upstream shell semantiği: komut shell üzerinden çalışır (pipe/redirect destekli).
			args.push("--", "bash", "-c", params.command);
			let out;
			try {
				out = await pi.exec("hbmon", args, { cwd: ctx?.cwd, timeout: 30_000 });
			} catch (err: any) {
				throw new Error(`hbmon watch failed: ${err?.message ?? err}`);
			}
			if (out.code !== 0) throw new Error(`hbmon watch failed: ${(out.stderr || out.stdout).slice(0, 300)}`);
			let hs: any;
			try {
				hs = firstJsonLine(out.stdout);
			} catch {
				throw new Error("hbmon: could not parse handshake");
			}
			const uuid = String(hs.uuid);
			const sock = String(hs.sock);
			const log = String(hs.log ?? sock.replace(/\.sock$/, ".jsonl"));
			const task: HbTask = {
				id: uuid,
				name,
				command: params.command,
				description: typeof params.description === "string" ? params.description : undefined,
				isAgent: params.isAgent,
				status: "running",
				exitCode: null,
				sock,
				logPath: log,
				outputPath: outFromSock(sock),
				cwd: ctx?.cwd ?? process.cwd(),
				startedAt: Date.now(),
				notified: false,
				notifyOnCompletion: notify,
				triggerOnCompletion: trigger,
				misses: 0,
			};
			tasks.set(uuid, task);
			saveRegistry();
			if (ctx?.hasUI) uiRef = ctx.ui;
			currentCtx = ctx;
			ensurePoller(pi);
			refreshWidget();
			return textResult(
				`Started background task ${taskDisplayName(task)} (${shortId(uuid)})\nStatus: running\nOutput: ${task.outputPath}\n${completionGuidance(notify, trigger)}`,
				{ task: snapshot(task) },
			);
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background Status",
		description: "Inspect one background task or list all running/recent background tasks. This is a point-in-time inspection tool, not a waiting primitive.",
		promptSnippet: "Inspect point-in-time status for one or all background tasks; never poll it as a wait loop",
		promptGuidelines: [
			"Use bg_status for deliberate point-in-time inspection, not as a waiting primitive.",
			"A running result is not an instruction to poll again. Do not repeatedly call bg_status while an automatic terminal notification is pending.",
			"Use bg_status when the user explicitly requests an update, automatic completion handling was disabled, or concrete evidence suggests a task is hung; terminal notifications do not need reconfirmation.",
		],
		parameters: BgStatusParams,
		async execute(_id, params: any) {
			await pollOnce(pi);
			const selected = params.taskId ? [resolveTask(params.taskId)] : [...tasks.values()];
			return textResult(formatSnapshotList(selected), { tasks: selected.map(snapshot) });
		},
	});

	pi.registerTool({
		name: "bg_logs",
		label: "Background Logs",
		description: `Read bounded output from a background task for deliberate inspection. Output is capped at ${formatSize(MAX_LOG_BYTES)} for model safety and points to the full output file when truncated. Artımlı okuma için offset ver (önceki yanıtın next_offset'i); aynı offset tekrarı uyarı döndürür. wait_ms>0 verilirse bloklayan okuma yapar: yeni çıktı veya terminal durum gelene kadar en fazla wait_ms bekler (cap 30000); mevcut çıktı/terminal varsa hemen döner, yoksa effective_wait_ms + timed_out raporlanır.`,
		promptSnippet: "Read bounded task output when needed; pass wait_ms to block for new output instead of polling",
		promptGuidelines: [
			"Use bg_logs with a modest maxBytes value only when task output is needed, without flooding context.",
			"To wait for fresh output, pass wait_ms (max 30000) once instead of calling bg_logs/bg_status in a loop; the call blocks until new output or terminal state, then returns effective_wait_ms and timed_out.",
			"Do not repeatedly call bg_logs to wait for completion while an automatic terminal notification is pending.",
			"Use bg_status first only when a deliberate inspection requires the current task state; do not reconfirm a terminal notification.",
			"Artımlı okumada offset/next_offset zincirini kullan; aynı offset'i tekrar çağırma (uyarı alırsın).",
		],
		parameters: BgLogsParams,
		async execute(_id, params: any) {
			const task = resolveTask(params.taskId);
			const maxBytes = Math.min(
				typeof params.maxBytes === "number" && params.maxBytes > 0 ? Math.floor(params.maxBytes) : DEFAULT_LOG_BYTES,
				MAX_LOG_BYTES,
			);
			const useOffset = params.offset !== undefined;
			const tail = params.tail ?? true;
			// NABIZ-003: wait_ms parse (cap 30000 — aşım sessizce kırpılır + hint).
			const requested = typeof params.wait_ms === "number" && params.wait_ms > 0 ? Math.floor(params.wait_ms) : 0;
			const waitBudget = Math.min(requested, WAIT_CAP_MS);
			const clipped = requested > WAIT_CAP_MS;

			const buildReceipt = (): { text: string; hasNew: boolean } => {
				if (useOffset) {
					const repeat = waitBudget === 0 && offsetTracker.note(task.id, params.offset);
					// wait_ms ile beklemek sanctioned bekleme yoludur — tekrar uyarısı yalnızca
					// beklemesiz çağrılarda verilir.
					let receipt: string;
					let hasNew = false;
					try {
						const r = readOffset(task.outputPath, params.offset, maxBytes);
						hasNew = r.text !== "";
						receipt = formatCursorReceipt(taskDisplayName(task), params.offset, r, r.text);
					} catch (err: any) {
						receipt = `(no output yet at ${task.outputPath}: ${err?.message ?? err})`;
					}
					if (repeat) receipt = `[tekrar] yeni çıktı yok; bekle ya da bildirimi bekle (offset=${params.offset})\n${receipt}`;
					return {
						text: `${taskDisplayName(task)} (${shortId(task.id)}) [${task.status}] cursor:\n${receipt}`,
						hasNew,
					};
				}
				let body: string;
				try {
					const r = readBounded(task.outputPath, maxBytes, tail);
					body = r.text + (r.truncated ? `\n…(truncated at ${formatSize(maxBytes)}; full output: ${task.outputPath})` : "");
				} catch (err: any) {
					body = `(no output yet at ${task.outputPath}: ${err?.message ?? err})`;
				}
				return {
					text: `${taskDisplayName(task)} (${shortId(task.id)}) [${task.status}] ${tail ? "tail" : "head"}:\n${body}`,
					hasNew: false, // tail modunda yenilik = giriş anındaki size'a göre büyüme
				};
			};

			if (waitBudget > 0) {
				const t0 = Date.now();
				let terminal = await refreshOneTask(pi, task);
				// Yenilik tabanı: offset modunda istenen offset, tail modunda giriş size'ı.
				const offNum = useOffset && Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset)) : 0;
				const baseline: number | undefined = useOffset ? offNum : outFileSize(task.outputPath);
				let r = buildReceipt();
				let wake: string;
				if (terminal) {
					wake = "terminal";
				} else if (useOffset && r.hasNew) {
					wake = "immediate";
				} else {
					wake = "timeout";
					let remaining = waitBudget;
					while (remaining > 0 && !terminal) {
						const sliceSec = Math.max(1, Math.ceil(Math.min(WAIT_SLICE_MS, remaining) / 1000));
						try {
							await pi.exec(
								"hbmon",
								["wait", "--sock", task.sock, "--timeout", String(sliceSec), "--until", "done,failed,dep_missing,timeout"],
								{ timeout: (sliceSec + 15) * 1000 },
							);
						} catch {
							// daemon exec hatası → dosya/terminal kontrolüyle devam
						}
						terminal = await refreshOneTask(pi, task);
						const nowSize = outFileSize(task.outputPath);
						const grew =
							nowSize !== undefined && nowSize > 0 && (baseline === undefined ? true : nowSize > baseline);
						if (terminal || grew) {
							wake = terminal ? "terminal" : "new-output";
							break;
						}
						remaining = waitBudget - (Date.now() - t0);
					}
					r = buildReceipt();
				}
				const effective = Date.now() - t0;
				const timedOut = wake === "timeout";
				const waitLine =
					`(wait_ms=${requested}${clipped ? `→${waitBudget} (cap ${WAIT_CAP_MS}'e kırpıldı)` : ""}` +
					` effective_wait_ms=${effective} timed_out=${timedOut} wake=${wake})`;
				return textResult(`${r.text}\n${waitLine}`, {
					task: snapshot(task),
					wait: { requested_ms: requested, budget_ms: waitBudget, effective_wait_ms: effective, timed_out: timedOut, wake },
				});
			}
			const r = buildReceipt();
			return textResult(r.text, {
				task: snapshot(task),
			});
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Background Kill",
		description: "Stop a running background task by ID. Fails loudly if the task is unknown or already finished.",
		promptSnippet: "Stop a running background task by ID",
		promptGuidelines: ["Use bg_kill when the user asks to stop a background task or when a bg_run command is no longer needed."],
		parameters: BgKillParams,
		async execute(_id, params: any) {
			const task = resolveTask(params.taskId);
			if (task.status !== "running") throw new Error(`Task ${shortId(task.id)} already finished (${task.status})`);
			const res = await pi.exec("hbmon", ["kill", "--sock", task.sock], { timeout: 10_000 });
			if (res.code !== 0) throw new Error(`hbmon kill failed: ${(res.stderr || res.stdout).slice(0, 300)}`);
			await pollOnce(pi);
			if (tasks.has(task.id)) {
				// Daemon henüz bitirmediyse killed olarak işaretle; poller devralır.
				task.status = "killed";
				task.exitCode = -1;
				tasks.delete(task.id);
				offsetTracker.forget(task.id);
				saveRegistry();
				refreshWidget();
				await notifyCompletion(pi, task);
			}
			return textResult(`Killed background task ${taskDisplayName(task)} (${shortId(task.id)}). Output: ${task.outputPath}`, {
				task: snapshot(task),
			});
		},
	});

	pi.registerCommand("bg", {
		description: "Run a command in background via hbmon (LLM notified on finish)",
		handler: async (args, ctx: any) => {
			const cmd = (args ?? "").trim();
			if (!cmd) {
				ctx.ui.notify("Usage: /bg <command>", "error");
				return;
			}
			if (ctx.hasUI) uiRef = ctx.ui;
			currentCtx = ctx;
			let out;
			try {
				out = await pi.exec("hbmon", ["watch", "--detach", "--", "bash", "-c", cmd], { cwd: ctx.cwd, timeout: 30_000 });
			} catch (err: any) {
				ctx.ui.notify(`hbmon watch failed: ${err?.message ?? err}`, "error");
				return;
			}
			if (out.code !== 0) {
				ctx.ui.notify(`hbmon watch failed: ${(out.stderr || out.stdout).slice(0, 300)}`, "error");
				return;
			}
			let hs: any;
			try {
				hs = firstJsonLine(out.stdout);
			} catch {
				ctx.ui.notify("hbmon: could not parse handshake", "error");
				return;
			}
			const uuid = String(hs.uuid);
			const sock = String(hs.sock);
			tasks.set(uuid, {
				id: uuid,
				name: deriveTaskNameFromCommand(cmd),
				command: cmd,
				isAgent: false,
				status: "running",
				exitCode: null,
				sock,
				logPath: String(hs.log ?? sock.replace(/\.sock$/, ".jsonl")),
				outputPath: outFromSock(sock),
				cwd: ctx.cwd,
				startedAt: Date.now(),
				notified: false,
				notifyOnCompletion: true,
				triggerOnCompletion: true,
				misses: 0,
			});
			saveRegistry();
			ensurePoller(pi);
			refreshWidget();
			ctx.ui.notify(`bg watching ${shortId(uuid)}: ${cmd}`, "info");
		},
	});

	pi.registerCommand("bg-status", {
		description: "Poll hbmon background jobs now",
		handler: async (_args, ctx: any) => {
			if (ctx.hasUI) uiRef = ctx.ui;
			currentCtx = ctx;
			try {
				if ((await adoptOrphans(pi, loadRegistry())) > 0) {
					saveRegistry();
					ensurePoller(pi);
					refreshWidget();
				}
			} catch {
				// best-effort
			}
			if (tasks.size === 0) {
				ctx.ui.notify("bg: no tracked jobs (daemons may still run — see hbmon list)", "info");
				return;
			}
			await pollOnce(pi);
			ctx.ui.notify(
				[...tasks.values()].map((t) => `${shortId(t.id)} [${t.status}] :: ${taskDisplayName(t)}`).join(" | ") ||
					"all jobs finished — results delivered",
				"info",
			);
		},
	});
}
