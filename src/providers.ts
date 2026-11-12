import {
  type Descriptor,
  DescriptorSchema,
  validateBinding,
} from "../extensions/models/_lib/contracts.ts";
import type { Config } from "./config.ts";

export const builtins: Descriptor[] = [
  {
    id: "guest-nordvpn",
    roles: ["network"],
    type: "hoardarr/network-session",
    version: "2026.11.11.4",
    capabilities: ["guest-readiness"],
    methods: { inspect: "inspect-guest", assertReady: "assert-guest" },
  },
  {
    id: "torlink",
    roles: ["search", "downloader"],
    type: "@funsaized/torlink",
    version: "2026.11.05.1",
    capabilities: ["torrent", "seed-time", "local-payload"],
    methods: {
      search: "search",
      health: "health",
      network: "network",
      add: "add",
      sync: "sync",
      control: "control",
    },
  },
  {
    id: "tmdb",
    roles: ["discovery"],
    type: "@keeb/tmdb-lookup",
    version: "2026.07.03.1",
    capabilities: ["movies", "episodes"],
    methods: { movies: "digitalReleases", episodes: "airedEpisodes" },
  },
  {
    id: "local",
    roles: ["destination"],
    type: "@funsaized/hoardarr/local-destination",
    version: "2026.11.09.1",
    capabilities: ["verified-receipt", "local-payload"],
    methods: { deliver: "deliver" },
  },
  {
    id: "ssh",
    roles: ["destination"],
    type: "@funsaized/hoardarr/ssh-destination",
    version: "2026.11.09.1",
    capabilities: ["verified-receipt", "local-payload"],
    methods: { deliver: "deliver" },
  },
  {
    id: "gluetun",
    roles: ["network"],
    type: "@funsaized/hoardarr/gluetun-environment",
    version: "2026.11.09.1",
    capabilities: ["isolated-network"],
    methods: {
      inspect: "inspect",
      assertReady: "inspect",
    },
  },
  {
    id: "fixture",
    roles: ["discovery", "search", "downloader", "network"],
    type: "@funsaized/hoardarr/fixture",
    version: "2026.11.11.4",
    capabilities: ["torrent", "seed-time", "local-payload", "offline"],
    methods: {
      movies: "movies",
      episodes: "episodes",
      search: "search",
      health: "health",
      add: "add",
      sync: "sync",
      control: "control",
      inspect: "inspect",
      assertReady: "inspect",
    },
  },
].map((d) => DescriptorSchema.parse({ contractVersion: 1, ...d }));

export async function resolveProviders(config: Config): Promise<Record<string, Descriptor>> {
  const descriptors = new Map(builtins.map((d) => [d.id, d]));
  for (const path of config.providerFiles) {
    const value = DescriptorSchema.parse(JSON.parse(await Deno.readTextFile(path)));
    if (descriptors.has(value.id)) throw new Error(`Duplicate provider id: ${value.id}`);
    descriptors.set(value.id, value);
  }
  const selected: Record<string, Descriptor> = {};
  for (const [role, id] of Object.entries(config.providers)) {
    const descriptor = descriptors.get(id);
    if (!descriptor) throw new Error(`Unknown ${role} provider: ${id}`);
    validateBinding(descriptor, role as Descriptor["roles"][number]);
    selected[role] = descriptor;
  }
  if (!selected.downloader.capabilities.includes("local-payload")) {
    throw new Error("Downloader needs a supported local payload mapping");
  }
  if (!selected.destination.capabilities.includes("verified-receipt")) {
    throw new Error("Destination must produce verified receipts");
  }
  return selected;
}
