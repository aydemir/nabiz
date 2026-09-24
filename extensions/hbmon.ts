/**
 * hbmon — uzun build takibi için pi extension (Faz 1 port, Faz 3 core bağlantısı).
 *
 * Port kaynağı: /root/opencode-plugins/plugins/opencode-hbmon.ts +
 * plugins/lib/hbmon-tools.ts (TASK-126). Davranış birebir korunur:
 * aynı handshake, aynı özet cümleleri, aynı `until` isimleri.
 *
 * Faz 3: motor (runHbmon/watchBuild/waitBuild/statusBuild/summarizeWait)
 * nabiz-core/hbmon-tools'tan gelir; bu dosyada yalnızca pi tool sarmalayıcıları
 * (şemalar + textResult + registerTool) kalır.
 *
 * Yükleme: pi -e /root/nabiz/extensions/hbmon.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveHbmonBin, statusBuild, waitBuild, watchBuild } from "nabiz-core/hbmon-tools";

// (motor: nabiz-core/hbmon-tools — HbmonRun/runHbmon/watchBuild/waitBuild/summarizeWait/statusBuild)

// --- pi extension ---

const WatchParams = Type.Object({
  command: Type.Array(Type.String(), {
    description: "Build komutu argv dizisi, örn. ['cargo','build','--release']",
  }),
  uuid: Type.Optional(Type.String({ description: "İzleyici kimliği (boşsa üretilir)" })),
  timeout_sec: Type.Optional(
    Type.Number({ description: "Derleme tavanı sn (sonra SIGTERM→SIGKILL, exit 124)" }),
  ),
});

const WaitParams = Type.Object({
  sock: Type.String({ description: "hbmon_watch'tan dönen sock" }),
  timeout: Type.Optional(Type.Number({ description: "Daemon tavanı sn (default 50)" })),
  until: Type.Optional(
    Type.String({
      description: "Erken-dönüş sinyalleri, virgüllü (done,failed,dep_missing,stall_suspect,oom_suspect,timeout). Yoksa yalnızca bitiş.",
    }),
  ),
});

const StatusParams = Type.Object({
  sock: Type.String({ description: "hbmon_watch'tan dönen sock" }),
});

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

export default function (pi: ExtensionAPI) {
  const bin = resolveHbmonBin();

  pi.registerTool({
    name: "hbmon_watch",
    label: "hbmon watch",
    description:
      "Uzun build turn-içi takip: komutu hbmon ile arka planda başlat, hemen dön (bash'te bloklama). Dönen sock'u sonraki hbmon_wait/hbmon_status çağrılarına ver. Argv dizisi ver, shell yok.",
    parameters: WatchParams,
    async execute(_id, params) {
      const w = await watchBuild(bin, params.command, {
        uuid: params.uuid,
        timeoutSec: params.timeout_sec,
      });
      if (!w.handshake) return textResult(`hbmon_watch BAŞARISIZ: ${w.error}`);
      return textResult(
        [
          `hbmon_watch OK uuid=${w.handshake.uuid}`,
          `sock=${w.handshake.sock}`,
          `log=${w.handshake.log}`,
          "Sonra: hbmon_wait (bekle) veya hbmon_status (yokla).",
        ].join("\n"),
        { uuid: w.handshake.uuid, sock: w.handshake.sock },
      );
    },
  });

  pi.registerTool({
    name: "hbmon_wait",
    label: "hbmon wait",
    description:
      "Sock'lu build bitene kadar bloklanarak bekle (polling YOK — bu çağrı uyandırır). Daemon tavanı default 50s; `timeout (hâlâ çalışıyor)` dönerse aynı sock ile tekrar çağır. Erken-dönüş için until: done,failed,dep_missing,stall_suspect,oom_suspect,timeout (virgüllü).",
    parameters: WaitParams,
    async execute(_id, params) {
      const w = await waitBuild(bin, params.sock, {
        timeoutSec: params.timeout,
        until: params.until,
      });
      const body = w.response !== undefined ? JSON.stringify(w.response) : "";
      return textResult(body === "" ? w.summary : `${w.summary}\n${body}`, w.response);
    },
  });

  pi.registerTool({
    name: "hbmon_status",
    label: "hbmon status",
    description:
      "Sock'lu build'in anlık özeti (ağaç+metrik+sağlık). Hızlı yoklama, beklemez. hbmon_wait `woke_on=... state=running/stalled` dönerse detaya bununla bak.",
    parameters: StatusParams,
    async execute(_id, params) {
      const s = await statusBuild(bin, params.sock);
      if (!s.response) return textResult(`hbmon_status BAŞARISIZ: ${s.error}`);
      return textResult(JSON.stringify(s.response), s.response);
    },
  });
}
