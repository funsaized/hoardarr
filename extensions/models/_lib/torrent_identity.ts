/** Offline v1 identity checks. Raw info bytes follow https://www.bittorrent.org/beps/bep_0003.html. */
import { createHash } from "node:crypto";

export function magnetIdentity(magnet: string): string {
  const hashes = new Set(
    new URL(magnet).searchParams.getAll("xt").filter((value) =>
      value.toLowerCase().startsWith("urn:btih:")
    ).map((value) => {
      const hash = value.slice(9);
      if (/^[a-f0-9]{40}$/i.test(hash)) return hash.toLowerCase();
      if (!/^[a-z2-7]{32}$/i.test(hash)) throw new Error("Unsupported torrent identity encoding");
      let valueBits = 0, bits = 0, result = "";
      for (const char of hash.toUpperCase()) {
        valueBits = (valueBits << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
        bits += 5;
        if (bits >= 8) {
          bits -= 8;
          result += ((valueBits >> bits) & 255).toString(16).padStart(2, "0");
        }
      }
      return result;
    }),
  );
  if (hashes.size !== 1) {
    throw new Error("Torrent locator has missing or conflicting v1 identities");
  }
  return [...hashes][0];
}

/** Reject partial/noncanonical metadata and hash the original encoded info dictionary. */
export function torrentIdentity(bytes: Uint8Array): string {
  if (bytes.length > 64 * 1024 * 1024 || bytes[0] !== 100) {
    throw new Error("Invalid torrent metadata size or root");
  }
  let offset = 0, info: Uint8Array | undefined;
  const text = (begin: number, end: number) => new TextDecoder().decode(bytes.subarray(begin, end));
  const string = () => {
    const begin = offset;
    while (bytes[offset] >= 48 && bytes[offset] <= 57) offset++;
    const digits = text(begin, offset);
    if (!/^(0|[1-9][0-9]*)$/.test(digits) || bytes[offset++] !== 58) {
      throw new Error("Invalid bencoded string");
    }
    const length = Number(digits);
    if (!Number.isSafeInteger(length) || offset + length > bytes.length) {
      throw new Error("Truncated torrent metadata");
    }
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const compare = (a: Uint8Array, b: Uint8Array) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  };
  const skip = (depth: number): void => {
    if (depth > 64 || offset >= bytes.length) throw new Error("Invalid torrent metadata nesting");
    const kind = bytes[offset];
    if (kind >= 48 && kind <= 57) {
      string();
      return;
    }
    if (kind === 105) {
      const begin = ++offset;
      while (offset < bytes.length && bytes[offset] !== 101) offset++;
      if (offset >= bytes.length || !/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(text(begin, offset))) {
        throw new Error("Invalid bencoded integer");
      }
      offset++;
      return;
    }
    if (kind !== 100 && kind !== 108) throw new Error("Invalid bencoded value");
    offset++;
    let previous: Uint8Array | undefined;
    while (offset < bytes.length && bytes[offset] !== 101) {
      if (kind === 100) {
        const key = string();
        if (previous && compare(previous, key) >= 0) {
          throw new Error("Unordered or duplicate torrent dictionary key");
        }
        previous = key;
        const begin = offset;
        if (depth === 0 && textKey(key) === "info") {
          if (bytes[offset] !== 100) throw new Error("Torrent info is not a dictionary");
          skip(depth + 1);
          info = bytes.subarray(begin, offset);
        } else skip(depth + 1);
      } else skip(depth + 1);
    }
    if (bytes[offset++] !== 101) throw new Error("Truncated torrent container");
  };
  const textKey = (key: Uint8Array) => new TextDecoder().decode(key);
  skip(0);
  if (offset !== bytes.length || !info) {
    throw new Error("Incomplete torrent identity or trailing metadata");
  }
  return createHash("sha1").update(info).digest("hex");
}
