/// <reference lib="deno.ns" />
import { testing } from "./host_bootstrap.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejects(
  fn: () => Promise<unknown>,
  includes: string,
): Promise<void> {
  let message = "";
  try {
    await fn();
  } catch (error) {
    message = String(error);
  }
  assert(
    message.includes(includes),
    `Expected '${includes}', got '${message}'`,
  );
}

Deno.test("installUnits is idempotent and rolls back a failed reload", async () => {
  const root = await Deno.makeTempDir({ prefix: "hoardarr-bootstrap-" });
  const pairs = ["one", "two"].map((name) => ({
    source: `${root}/${name}.source`,
    destination: `${root}/${name}.service`,
  }));
  let reloads = 0;
  try {
    for (const pair of pairs) await Deno.writeTextFile(pair.source, "first\n");
    assert(
      await testing.installUnits(pairs, () => {
        reloads++;
        return Promise.resolve();
      }),
      "First install was skipped",
    );
    assert(reloads === 1, "Initial install did not reload exactly once");
    assert(
      !(await testing.installUnits(pairs, () => {
        reloads++;
        return Promise.resolve();
      })),
      "Matching units were rewritten",
    );
    assert(reloads === 1, "Unchanged units triggered a reload");

    for (const pair of pairs) await Deno.writeTextFile(pair.source, "second\n");
    await rejects(
      () =>
        testing.installUnits(
          pairs,
          () => Promise.reject(new Error("reload failed")),
        ),
      "reload failed",
    );
    for (const pair of pairs) {
      assert(
        await Deno.readTextFile(pair.destination) === "first\n",
        `${pair.destination} was not rolled back`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("unit assets preserve the bootstrap safety baseline", async () => {
  const swamp = await Deno.readTextFile(
    new URL("../../assets/systemd/hoardarr-swamp.service", import.meta.url),
  );
  const torlink = await Deno.readTextFile(
    new URL("../../assets/systemd/torlink.service", import.meta.url),
  );
  assert(swamp.includes("--host 127.0.0.1"), "Swamp is not loopback-only");
  assert(!swamp.includes("--no-schedule"), "Swamp scheduling is disabled");
  assert(swamp.includes("Restart=on-failure"), "Swamp restart policy changed");
  assert(torlink.includes("--host 127.0.0.1"), "Torlink is not loopback-only");
  assert(torlink.includes("--seed-time 5m"), "Torlink seed time changed");
  assert(!torlink.includes("--delete-files"), "Torlink deletes payload files");
  assert(torlink.includes("Restart=no"), "Torlink restart policy changed");
});
