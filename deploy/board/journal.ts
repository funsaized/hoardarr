import { type FeedEntry, logText } from "./feed.ts";

export function journalEntry(raw: string): FeedEntry | null {
  let row;
  try {
    row = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    row._SYSTEMD_UNIT !== "hoardarr-swamp.service" || typeof row.MESSAGE !== "string" ||
    typeof row.__CURSOR !== "string"
  ) return null;
  const msg = row.MESSAGE.replace(/\x1b\[[\d;]*m/g, "").replace(/^\s*system\s*│\s*/, "");
  const ref = msg.match(/\(run: "([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})"\)/i);
  const label = logText(ref ? msg.replace(ref[0], "").trim() : msg);
  const ms = Number(row.__REALTIME_TIMESTAMP) / 1000;
  if (!label || !Number.isFinite(ms) || ms <= 0 || ms > 8640000000000000) return null;
  return {
    id: "journal-" + row.__CURSOR,
    at: new Date(ms).toISOString(),
    source: "Log",
    label,
    detail: Number(row.PRIORITY) <= 3
      ? "Swamp service · error"
      : Number(row.PRIORITY) === 4
      ? "Swamp service · warning"
      : "Swamp service",
    ...(ref ? { run: ref[1], kind: "workflow" as const } : {}),
  };
}

export function journalStream() {
  const entries = new Map<string, FeedEntry>();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let connected = false;
  const send = (client: ReadableStreamDefaultController<Uint8Array>, data: Uint8Array) => {
    try {
      if ((client.desiredSize ?? 0) <= 0) {
        client.close();
        clients.delete(client);
      } else client.enqueue(data);
    } catch {
      clients.delete(client);
    }
  };
  function broadcast(type: string, data: unknown) {
    const frame = encoder.encode("event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n");
    for (const client of clients) send(client, frame);
  }
  const follow = async () => {
    for (;;) {
      let conn: Deno.UnixConn | undefined;
      try {
        conn = await Deno.connect({ transport: "unix", path: "/run/hoardarr/swamp-feed.sock" });
        connected = true;
        broadcast("status", { connected });
        let carry = "";
        for await (const block of conn.readable.pipeThrough(new TextDecoderStream())) {
          const lines = (carry + block).split("\n");
          carry = lines.pop() ?? "";
          if (carry.length > 262144) throw Error("Oversized journal record");
          const added = [];
          for (const line of lines) {
            const e = journalEntry(line);
            if (e && !entries.has(e.id)) {
              entries.set(e.id, e);
              added.push(e);
            }
          }
          while (entries.size > 240) entries.delete(entries.keys().next().value!);
          if (added.length) broadcast("entries", added.slice(-240));
        }
      } catch {
        /* The guest socket reconnects after Swamp or the log reader restarts. */
      } finally {
        try {
          conn?.close();
        } catch { /* closed by stream */ }
        connected = false;
        broadcast("status", { connected });
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  };
  void follow();
  const heartbeat = setInterval(() => broadcast("status", { connected }), 15000);
  Deno.unrefTimer(heartbeat);
  return (headers: Record<string, string>) => {
    if (clients.size >= 48) return new Response(null, { status: 503, headers });
    let current: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        current = controller;
        clients.add(current);
        send(
          current,
          encoder.encode(
            "retry: 3000\nevent: status\ndata: " + JSON.stringify({ connected }) +
              "\n\nevent: entries\ndata: " + JSON.stringify([...entries.values()]) + "\n\n",
          ),
        );
      },
      cancel() {
        clients.delete(current);
      },
    }, { highWaterMark: 16 });
    return new Response(stream, {
      headers: { ...headers, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" },
    });
  };
}
