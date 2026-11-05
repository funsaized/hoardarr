# Container installation

Requirements: Linux x86-64, Docker with Compose, `/dev/net/tun`, a WireGuard
configuration from your VPN provider, a TMDB API key, and a Swamp account.
Docker may be invoked through sudo/polkit; membership in the docker group is not
required. The containers run as your configured UID/GID with dropped capabilities;
only Gluetun receives `NET_ADMIN`.

Prepare an installation from the release source:

```sh
bin/hoardarr init --profile compose-vpn-local --dir "$HOME/hoardarr-instance"
cd "$HOME/hoardarr-instance"
cp .env.example .env
```

Set `HOARDARR_UID` and `HOARDARR_GID` to the owner of the instance and payload
directories. Keep the same UID inside both application containers. For a NAS,
mount it on the host first and change the library bind mount in `compose.yaml`.
Do not place the library inside the downloads directory.

Create these local files with mode 600, owned by that UID:

- `secrets/wg0.conf`: your provider's WireGuard client configuration. Full IPv4
  tunneling is required. IPv6 is disabled for this initial profile.
- `secrets/gluetun-auth.toml`: copy the supplied example and set a random API key.
- `secrets/swamp-api-key`: a Swamp API key for noninteractive commands.
- `secrets/swamp-signin-token`: the corresponding Swamp sign-in token if required
  by your account/runtime. See `swamp auth` and `swamp auth token --help`.

Swamp credentials are files, never Compose command arguments. The authentication
paths follow [Swamp's documentation](https://github.com/swamp-club/swamp).
WireGuard file import and the firewall behavior follow
[Gluetun's WireGuard guide](https://github.com/qdm12/gluetun-wiki/blob/main/setup/options/wireguard.md)
and [firewall guide](https://github.com/qdm12/gluetun-wiki/blob/main/setup/options/firewall.md).

Start the VPN and services:

```sh
docker compose up -d
docker compose logs --tail 50 hoardarr
```

The initial startup generates the Swamp installation with scheduling disabled.
Store secrets through hidden prompts once initialization completes:

```sh
docker compose exec hoardarr swamp vault put hoardarr TMDB_API_KEY --repo-dir /instance
docker compose exec hoardarr swamp vault put hoardarr GLUETUN_API_KEY --repo-dir /instance
```

The Gluetun vault value must match the API key in `gluetun-auth.toml`. Configure
interests and policies in the host's `hoardarr.yaml`, then apply and preview:

```sh
docker compose exec hoardarr /opt/hoardarr/bin/hoardarr apply --dir /instance --config /config/hoardarr.yaml
docker compose exec hoardarr /opt/hoardarr/bin/hoardarr doctor --dir /instance
docker compose exec hoardarr /opt/hoardarr/bin/hoardarr plan --refresh --dir /instance
docker compose exec hoardarr /opt/hoardarr/bin/hoardarr run --dir /instance
```

Enable the schedule by setting `schedule.enabled: true` in the host configuration
and applying it. The host file remains the startup source of truth. Using only
`schedule enable` inside the container would be overwritten by that file on restart.

Both the Torlink daemon and local search execute in Gluetun's network namespace.
No application or control ports are exposed to the host. A lost tunnel blocks
network operations; `docker compose exec` still provides local access to logs,
configuration, and persisted state. Do not disable Gluetun's firewall or add broad
outbound subnet exemptions. Readiness checks supplement the firewall; they do not
replace it.

On upgrade, stop the application service, back up `instance`, `runtime-home`,
configuration, secrets, and Torlink state, pull the new version, and restart.
Payload/library backups are separate. Never restore an old catalog after new
external work without reconciling the resulting copies and downloads.
