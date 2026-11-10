# Install with Compose

You need Linux x86-64, Docker with Compose, `/dev/net/tun`, a provider WireGuard configuration, a
TMDB key and a Swamp account. You can run Docker through sudo or polkit; docker group membership is
optional.

The applications run as your chosen UID/GID with capabilities dropped. Only Gluetun gets
`NET_ADMIN`.

## 1. Create the installation

Run from the release source:

```sh
bin/hoardarr init --profile compose-vpn-local --dir "$HOME/hoardarr-instance"
cd "$HOME/hoardarr-instance"
cp .env.example .env
```

Set `HOARDARR_UID` and `HOARDARR_GID` to the owner of the instance and payload directories. Use the
same UID for both application containers.

For a NAS, mount it on the host first, then change the library bind mount in `compose.yaml`. Keep
the library outside the downloads directory.

## 2. Add credentials

Create these files with mode 600, owned by the configured UID:

- `secrets/wg0.conf`: the provider's WireGuard client configuration. It must tunnel all IPv4
  traffic. This profile disables IPv6.
- `secrets/gluetun-auth.toml`: copy the supplied example and choose a random API key.
- `secrets/swamp-api-key`: a Swamp API key for unattended commands.
- `secrets/swamp-signin-token`: the matching sign-in token if your account/runtime requires it. See
  `swamp auth` and `swamp auth token --help`.

Keep Swamp credentials in files rather than Compose arguments. See
[Swamp's documentation](https://github.com/swamp-club/swamp) for authentication, and Gluetun's
[WireGuard guide](https://github.com/qdm12/gluetun-wiki/blob/main/setup/options/wireguard.md) and
[firewall guide](https://github.com/qdm12/gluetun-wiki/blob/main/setup/options/firewall.md) for the
VPN configuration.

## 3. Start the services

```sh
docker compose up -d
docker compose logs --tail 50 hoardarr
```

Startup generates the Swamp installation with scheduling disabled. Once initialization finishes,
store the application secrets through hidden prompts:

```sh
docker compose exec hoardarr swamp vault put hoardarr TMDB_API_KEY --repo-dir /instance
docker compose exec hoardarr swamp vault put hoardarr GLUETUN_API_KEY --repo-dir /instance
```

The Gluetun vault value must match the key in `gluetun-auth.toml`.

## 4. Preview and run

Set interests and policies in the host's `hoardarr.yaml`, then apply and preview:

```sh
docker compose exec hoardarr /opt/hoardarr/bin/hoardarr apply --dir /instance --config /config/hoardarr.yaml
docker compose exec hoardarr /opt/hoardarr/bin/hoardarr doctor --dir /instance
docker compose exec hoardarr /opt/hoardarr/bin/hoardarr plan --refresh --dir /instance
docker compose exec hoardarr /opt/hoardarr/bin/hoardarr run --dir /instance
```

To schedule runs, set `schedule.enabled: true` in the host configuration and apply it. Startup reads
that file, replacing any `schedule enable` change made only inside the container.

## Network access

Torlink's daemon and local search share Gluetun's network namespace. Compose exposes no application
or control ports to the host. If the tunnel fails, the firewall blocks network work;
`docker compose exec` still gives you access to logs, configuration and saved state.

Keep Gluetun's firewall enabled and avoid broad outbound subnet exemptions. Readiness checks help
detect problems; the firewall enforces the boundary.

## Upgrade

Stop the application service. Back up `instance`, `runtime-home`, configuration, secrets and Torlink
state, then pull the new version and restart. Back up payloads and the library separately.

If new downloads or transfers happened after a catalog backup, reconcile those effects before
restoring the older catalog.

[Back to the README](../../README.md#reference)
