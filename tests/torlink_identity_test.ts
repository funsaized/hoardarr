import { createHash } from "node:crypto";
import { magnetIdentity, torrentIdentity } from "../extensions/models/_lib/torrent_identity.ts";
import { initializeTorlinkState, readTorlinkState } from "../src/torlink_state.ts";
import { durableJson } from "../extensions/models/_lib/durable.ts";
import { assert, rejects, temporary } from "./helpers.ts";

const bytes = (value: string) => new TextEncoder().encode(value);
const info = bytes("d6:lengthi1e4:name1:x12:piece lengthi1e6:pieces20:" + "p".repeat(20) + "e");
const metadata = bytes(
  "d8:announce16:http://localhost4:info" + new TextDecoder().decode(info) + "e",
);
const id = createHash("sha1").update(info).digest("hex");

Deno.test("torrent metadata hashes original info bytes and rejects partial, duplicate and noncanonical data", async () => {
  assert(torrentIdentity(metadata) === id);
  await rejects(() => torrentIdentity(metadata.subarray(0, metadata.length - 1)));
  await rejects(() => torrentIdentity(bytes(new TextDecoder().decode(metadata) + "junk")));
  await rejects(() => torrentIdentity(bytes("d4:infod1:ai01eee")));
  await rejects(() => torrentIdentity(bytes("d4:infode4:infodee")));
});
Deno.test("magnet identities retain hex, escaped and base32 locators and refuse conflicts", async () => {
  assert(magnetIdentity("magnet:?xt=" + encodeURIComponent("urn:btih:" + id)) === id);
  assert(magnetIdentity("magnet:?xt=urn:btih:" + "A".repeat(32)) === "0".repeat(40));
  await rejects(() => magnetIdentity(`magnet:?xt=urn:btih:${id}&xt=urn:btih:${"b".repeat(40)}`));
});
Deno.test("paused seed startup refuses a well-formed torrent belonging to another identity", () =>
  temporary(async (root) => {
    await initializeTorlinkState(root);
    await durableJson(root + "/data/history.json", [{
      id,
      name: "fixture",
      magnet: "magnet:?xt=urn:btih:" + id,
      dir: "/old/downloads/fixture",
      sizeBytes: 1,
      completedAt: 1,
    }]);
    await durableJson(root + "/data/seeds.json", [{ id, status: "paused" }]);
    await Deno.writeFile(root + "/data/torrents/" + id + ".torrent", metadata);
    assert((await readTorlinkState(root)).seeds.length === 1);
    const other = metadata.slice();
    other[other.indexOf(120, 32)] = 121;
    await Deno.writeFile(root + "/data/torrents/" + id + ".torrent", other);
    await rejects(() => readTorlinkState(root));
  }));
