import { z } from "npm:zod@4.5.1";
import {
  advanceSwitch,
  alternate,
  needsCandidateRefresh,
  partialIdentity,
  payloadName,
  refreshedCandidate,
  ReleaseSwitch,
  retainPartial,
  type Switch,
  SwitchPolicy,
} from "./switch_release.ts";
import { assertLease, invoke, recordExternalIntent, type Runtime } from "./runtime.ts";
import { episodeCatalogId, movieCatalogId } from "./catalog_identity.ts";
import { TransferObservation } from "./transfer_observation.ts";

type Options = {
  policy: z.infer<typeof SwitchPolicy>;
  expectedInterface: string;
  stagingRoot: string;
  minFreeBytes: number;
  maxGapMs: number;
  seedTime: string;
  movies: string;
  episodes: string;
  movieLimit: number;
  episodeLimit: number;
};
const Snapshot = z.object({
  capturedAt: z.iso.datetime(),
  telemetrySession: z.uuid(),
  network: z.object({
    online: z.boolean(),
    interface: z.string().nullable(),
    address: z.string().nullable(),
  }),
  torrents: z.array(
    z.object({
      infoHash: z.string(),
      name: z.string(),
      status: z.string(),
      metadataReady: z.boolean().optional(),
      downloadedBytes: z.number().optional(),
      totalBytes: z.number().optional(),
    }),
  ),
  seeds: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })),
});
export async function switchReleases(ctx: Runtime, owner: string, opts: Options) {
  await assertLease(ctx.repoDir, owner);
  const prior = (await ctx.readModelData("pipeline", "releaseSwitch")).map((r) =>
    ReleaseSwitch.parse(r.attributes)
  );
  const pending = prior.filter((r) => !["cancelled", "committed"].includes(r.phase));
  if (!pending.length && (!opts.policy.enabled || !opts.policy.titles.length)) return;
  const keyed = new Map<string, Record<string, unknown>>();
  for (const [name, kind] of [[opts.movies, "movie"], [opts.episodes, "episode"]]) {
    for (const { attributes: r } of await ctx.readModelData(name, kind)) {
      keyed.set(kind === "movie" ? "m-" + movieCatalogId(r) : "e-" + episodeCatalogId(r), r);
    }
  }
  async function sample() {
    await assertLease(ctx.repoDir, owner);
    const records = await invoke(ctx, "torlink", "sampleTransfers");
    const reading = Snapshot.parse(records.find((r) => r.name === "telemetry-current")?.attributes);
    const age = Date.now() - Date.parse(reading.capturedAt);
    if (
      age < 0 || age > 15000 || !reading.network.online || !reading.network.address ||
      reading.network.interface !== opts.expectedInterface
    ) {
      throw new Error("Release switch requires fresh downloader and VPN readings");
    }
    return reading;
  }
  const available = async () => {
    const records = await invoke(ctx, "staging-disk", "check");
    const result = records.find((r) => r.attributes.path === opts.stagingRoot);
    return z.number().int().nonnegative().parse(result?.attributes.availableBytes);
  };
  const observations = new Map(
    (await ctx.readModelData("pipeline", "transferObservation")).map(
      (r) => [r.name, TransferObservation.parse(r.attributes)],
    ),
  );
  for (
    const key of new Set([
      ...pending.map((r) => r.key),
      ...opts.policy.enabled ? opts.policy.titles : [],
    ])
  ) {
    const row = keyed.get(key);
    if (!row) continue;
    const movie = key.startsWith("m-"),
      id = Number(key.slice(2)),
      catalog = movie ? opts.movies : opts.episodes;
    const foreign = [...keyed].filter(([k]) => k !== key).map(([, v]) => v);
    const blocked = new Set(
      foreign.flatMap((r) => typeof r.infoHash === "string" ? [r.infoHash.toLowerCase()] : []),
    );
    const ranked = z.array(z.unknown()).parse(row.rankedReleases ?? []);
    const maxAttempts = movie ? opts.movieLimit : opts.episodeLimit;
    for (
      const [hash, until] of Object.entries(
        z.record(z.string(), z.string()).parse(row.stalledReleases ?? {}),
      )
    ) {
      if (Date.parse(until) > Date.now()) blocked.add(hash);
    }
    for (
      const rejection of z.array(z.object({ infoHash: z.string() })).parse(
        row.rejectedReleases ?? [],
      )
    ) blocked.add(rejection.infoHash.toLowerCase());
    let journal = pending.find((r) => r.key === key);
    const save = async (s: Switch) => {
      await ctx.writeResource("releaseSwitch", "switch-" + key, s);
    };
    if (!journal) {
      if (
        row.status !== "downloading" || typeof row.infoHash !== "string" ||
        blocked.has(row.infoHash) || Number(row.attempts) >= maxAttempts - 1
      ) continue;
      const health = observations.get("transfer-health-" + (movie ? "movie-" : "episode-") + id);
      if (
        health?.decision !== "stall" || health.sample.hash !== row.infoHash ||
        health.sample.bytes === undefined ||
        Date.now() - health.sample.observedAt > opts.maxGapMs ||
        Date.now() < health.sample.observedAt
      ) continue;
      const snap = await sample();
      const old = snap.torrents.find((r) => r.infoHash === row.infoHash);
      if (
        !old || !payloadName(old.name) || old.status !== "downloading" ||
        old.downloadedBytes !== health.sample.bytes || !old.metadataReady ||
        snap.telemetrySession !== health.sample.session || foreign.some((r) =>
          r.releaseName === old.name && !r.localCleanedAt
        )
      ) continue;
      for (const r of snap.torrents) blocked.add(r.infoHash);
      for (const r of snap.seeds) blocked.add(r.id);
      const candidate = alternate(ranked, blocked, Date.now(), opts.policy.candidateMaxAgeHours);
      if (!candidate || await available() < opts.minFreeBytes + candidate.sizeBytes) continue;
      const partial = await partialIdentity(opts.stagingRoot, old.name);
      if (!partial && health.sample.bytes > 0) continue;
      const now = new Date().toISOString();
      journal = ReleaseSwitch.parse({
        key,
        attemptId: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        owner,
        phase: "planned",
        oldHash: row.infoHash,
        oldName: old.name,
        bytes: health.sample.bytes,
        session: snap.telemetrySession,
        partial,
        candidate,
      });
      await save(journal);
    }
    if (needsCandidateRefresh(journal, Date.now(), opts.policy.candidateMaxAgeHours)) {
      const live = await sample();
      const liveHashes = new Set([
        ...live.torrents.map((r) => r.infoHash),
        ...live.seeds.map((r) => r.id),
      ]);
      if (!liveHashes.has(journal.oldHash) && !liveHashes.has(journal.candidate.infoHash)) {
        const excluded = new Set([...blocked, ...liveHashes, journal.oldHash]);
        const refreshed = refreshedCandidate(
          journal,
          ranked,
          excluded,
          Date.now(),
          opts.policy.candidateMaxAgeHours,
        );
        if (refreshed) {
          journal = { ...journal, candidate: refreshed, updatedAt: new Date().toISOString() };
          await save(journal);
        }
      }
    }
    const j = journal, candidate = j.candidate;
    if (row.infoHash === candidate.infoHash && row.lastSwitch === j.attemptId) {
      await save({ ...j, phase: "committed", updatedAt: new Date().toISOString() });
      return;
    }
    if (row.infoHash !== j.oldHash) throw new Error("Release switch lost catalog ownership");
    if (row.status !== "downloading" || row.transferredAt) {
      await save({ ...j, phase: "cancelled", updatedAt: new Date().toISOString() });
      return;
    }
    const ownsAlt = foreign.some((r) => r.infoHash === candidate.infoHash);
    if (ownsAlt) throw new Error("Another title owns the proposed alternate");
    await advanceSwitch(j, {
      save,
      read: async () => {
        const snap = await sample();
        const old = snap.torrents.find((r) => r.infoHash === j.oldHash);
        const same = old?.status === "downloading" && old.name === j.oldName && old.metadataReady &&
          old.downloadedBytes === j.bytes && snap.telemetrySession === j.session;
        const conflict = snap.torrents.some((r) =>
          r.infoHash !== j.oldHash && r.infoHash !== candidate.infoHash && r.name === j.oldName
        ) || snap.seeds.some((r) =>
          r.id !== j.oldHash && r.id !== candidate.infoHash && r.name === j.oldName
        );
        if (conflict) {
          throw new Error("Staging payload is also referenced by another torrent");
        }
        return {
          old: same
            ? "active"
            : old || snap.seeds.some((r) =>
                r.id === j.oldHash
              )
            ? "changed"
            : "absent",
          alternate: snap.torrents.some((r) => r.infoHash === candidate.infoHash) ||
            snap.seeds.some((r) => r.id === candidate.infoHash),
          eligible: (Date.now() - Date.parse(candidate.selectedAt)) <=
              opts.policy.candidateMaxAgeHours * 3600000 &&
            !foreign.some((r) => r.infoHash === j.oldHash) &&
            await available() >= opts.minFreeBytes + candidate.sizeBytes,
        };
      },
      detach: async () => {
        await recordExternalIntent(ctx.repoDir, owner, "torlink.detachStalled");
        const r = await invoke(ctx, "torlink", "detachStalled", {
          id: j.oldHash,
          name: j.oldName,
          session: j.session,
          downloadedBytes: j.bytes,
          interface: opts.expectedInterface,
        });
        return r.find((r) => r.name === "detach-current")?.attributes.detached === true;
      },
      retain: async () => {
        await assertLease(ctx.repoDir, owner);
        await retainPartial(opts.stagingRoot, j);
      },
      add: async () => {
        const r = await invoke(ctx, "download-provider", "invoke", {
          owner,
          operation: "add",
          inputs: {
            inputs: [{
              key,
              input: candidate.magnet ?? candidate.infoHash,
              seedTime: opts.seedTime,
            }],
          },
          tolerateFailure: false,
        });
        if (r.find((r) => r.name === "result-current")?.attributes.ok !== true) {
          throw new Error("Alternate add requires reconciliation");
        }
      },
      commit: async () => {
        await invoke(ctx, catalog, "commitAlternate", {
          id,
          oldHash: j.oldHash,
          newHash: candidate.infoHash,
          candidate,
          attemptId: j.attemptId,
          nextEligibleAt: new Date(Date.now() + opts.policy.cooldownHours * 3600000).toISOString(),
        });
      },
    });
    // Read catalog ownership again on the next run before considering another title.
    return;
  }
}
