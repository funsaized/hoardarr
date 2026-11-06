import { ConfigSchema, defaultConfig } from "../src/config.ts";
import { resolveProviders } from "../src/providers.ts";
import { DescriptorSchema } from "../extensions/models/_lib/contracts.ts";
import { PolicySchema } from "../extensions/models/_lib/policy.ts";
import { model as movies } from "../extensions/models/movie_catalog.ts";
import { model as episodes } from "../extensions/models/episode_catalog.ts";
import { model as fixture } from "../extensions/models/fixture_provider.ts";
import { model as pipeline } from "../extensions/models/pipeline.ts";
import { assert, rejects, temporary } from "./helpers.ts";
Deno.test("configuration rejects overlapping roots, unknown settings and unsupported contract versions", async () => {
  const c = defaultConfig("/tmp/example", "demo");
  assert(ConfigSchema.parse(c).schedule.enabled === false);
  await rejects(() =>
    ConfigSchema.parse({ ...c, paths: { ...c.paths, library: c.paths.staging } })
  );
  await rejects(() => ConfigSchema.parse({ ...c, typo: true }));
  await rejects(() => DescriptorSchema.parse({ contractVersion: 2 }));
  assert((await resolveProviders(c)).downloader.id === "fixture");
});
Deno.test("provider descriptor installs a different destination without changing the catalog", () =>
  temporary(async (root) => {
    const c = defaultConfig(root, "demo"), path = `${root}/provider.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        contractVersion: 1,
        id: "example",
        roles: ["destination"],
        type: "@example/destination",
        version: "2026.11.05.1",
        capabilities: ["verified-receipt", "local-payload"],
        methods: { deliver: "publish" },
      }),
    );
    c.providerFiles = [path];
    c.providers.destination = "example";
    assert((await resolveProviders(c)).destination.methods.deliver === "publish");
  }));
Deno.test("new policy changes quality eligibility without changing legacy defaults", () => {
  const policy = PolicySchema.parse({ resolution: "720p", minSeeders: 2, maxSizeBytes: 1000 });
  assert(policy.resolution === "720p");
  assert(movies.globalArguments.parse({}).policy.resolution === "1080p");
  assert(episodes.globalArguments.parse({ shows: [] }).policy.maxSizeBytes === 8 * 1024 ** 3);
  assert(fixture.methods.add && pipeline.methods.recordAdd);
});
