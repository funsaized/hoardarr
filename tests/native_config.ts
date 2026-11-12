import { ConfigSchema, defaultConfig } from "../src/config.ts";

export function nativeConfig(root: string) {
  const c = defaultConfig(root, "demo"), installationId = crypto.randomUUID();
  return ConfigSchema.parse({
    ...c,
    schemaVersion: 2,
    profile: "devvm-nordvpn-local",
    providers: {
      discovery: "tmdb",
      search: "torlink",
      downloader: "torlink",
      destination: "local",
      network: "guest-nordvpn",
    },
    paths: {
      staging: `${root}/downloads`,
      library: `${root}/library`,
      state: `${root}/state/torlink`,
    },
    torlink: { ...c.torlink, interface: "nordlynx" },
    guest: {
      installationId,
      projectRoot: root,
      repoRoot: "/var/lib/hoardarr/control",
      purpose: "qualification",
      user: "media",
      uid: 1001,
      gid: 1001,
      home: `${root}/runtime-home`,
      vpnInterface: "nordlynx",
      vpnProtocol: "NORDLYNX",
      storage: {
        installationId,
        roots: [
          "instance",
          "downloads",
          "state/torlink",
          "library",
          "runtime-home",
          "state/maintenance",
          "secrets",
        ].map((p) => ({
          path: `${root}/${p}`,
          storageId: crypto.randomUUID(),
          mountPoint: root,
          fsType: "9p",
          source: "project",
        })),
      },
    },
  });
}
