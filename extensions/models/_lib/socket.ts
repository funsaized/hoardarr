/** Bounded read-only response from a root-owned local observation socket. */
export async function readObservation(path: string, signal: AbortSignal): Promise<unknown> {
  const socket = await Deno.connect({ transport: "unix", path }),
    reader = socket.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  const close = () => {
    try {
      socket.close();
    } catch { /* already closed */ }
  };
  timeout.addEventListener("abort", close, { once: true });
  try {
    timeout.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 32768) throw new Error("Observation response exceeds its bound");
      chunks.push(value);
    }
  } finally {
    timeout.removeEventListener("abort", close);
    reader.releaseLock();
    close();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
