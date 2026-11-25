import { deepStrictEqual, equal } from "node:assert/strict";
import { ingestReleaseFeeds } from "../extensions/models/_lib/release_feed.ts";
import type { RecordData, Runtime } from "../extensions/models/_lib/runtime.ts";

Deno.test("release feeds retain unverified regional evidence and share the weekly allowance on replay", async () => {
  const rows: RecordData[] = [];
  const outcomes = new Map<string, unknown>();
  const now = new Date("2026-11-25T12:00:00Z");
  const suggestion = (
    title: string,
    tmdbId: number,
    date: string,
    region = "US",
    kind = "digital",
  ) => ({
    name: title,
    attributes: {
      title,
      tmdbId,
      year: 2026,
      releases: [{ kind, date, region, source: "Licensed release list" }],
    },
  });
  const releases = [
    suggestion("Theatrical", 10, "2026-11-23", "US", "theatrical"),
    suggestion("Other region", 11, "2026-11-23", "GB"),
    suggestion("Upcoming", 12, "2027-01-02"),
    suggestion("Available", 13, "2026-11-23"),
    suggestion("Next", 14, "2026-11-23"),
  ];
  const ctx: Runtime = {
    repoDir: "/tmp",
    signal: new AbortController().signal,
    async readModelData(name) {
      return name === "catalog"
        ? rows
        : name === "feed"
        ? releases
        : [{ name: "saved", attributes: { discoveredAt: "2026-11-24T12:00:00Z", region: "US" } }];
    },
    async runModel({ arguments: args }) {
      const [attributes] = args!.discoveries as Record<string, unknown>[];
      rows.push({ name: "movie-" + attributes.tmdbId, attributes });
      return { ok: true, resources: [] };
    },
    async writeResource(_spec, name, value) {
      outcomes.set(String(value.title), value.reason);
      return { name };
    },
  };
  for (let n = 0; n < 2; n++) {
    equal(await ingestReleaseFeeds(ctx, ["feed"], "US", 2, "catalog", "tmdb", now), 0);
  }
  deepStrictEqual(rows.map((r) => r.attributes.tmdbId), [13]);
  equal(outcomes.get("Theatrical"), "Missing dated regional digital-release evidence");
  equal(outcomes.get("Upcoming"), outcomes.get("Other region"));
  equal(outcomes.get("Next"), "Weekly discovery allowance reached");
  equal(outcomes.get("Available"), "Confirmed identity already in catalog");
});
