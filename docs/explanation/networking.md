# Networking

A readiness check tells you whether the VPN works now. The firewall controls where packets can go if
that connection fails a moment later. Hoardarr needs both.

```text
Compose host                    Native DevVM host
  | docker exec                   | DevVM management transport
  v                               v
gluetun namespace               Linux guest
  Hoardarr + Torlink               management user / root -> VM administration
        |                         service UID -> egress guard -> NordVPN tunnel
  Gluetun firewall                      |
        |                            Internet
  WireGuard tunnel
        |
     Internet
```

## Compose

Hoardarr's search and the Torlink daemon share Gluetun's network namespace. Only Gluetun gets
`NET_ADMIN`; the application containers drop capabilities. Control APIs listen on loopback, and the
Compose file publishes no ports.

If the VPN fails, `docker exec` still lets you inspect the containers. This profile disables IPv6.
Its resolver must also avoid Docker's DNS proxy, which could send queries outside the tunnel.

## Native VM

The application UID cannot control NordVPN. A root-owned status broker reports readiness, while a
separate firewall guard restricts that UID's outgoing traffic. Torlink binds to the chosen tunnel
interface.

The launcher gives the application a clean environment without inherited proxies or shell startup
hooks. Management access uses a separate identity, so an operator can still diagnose a broken VPN.
The host's own VPN and Tailscale routing do not need to change for local library delivery.

## What qualification checks

DevVM's host proxy and local relay could provide other routes out. The native test matrix checks
those routes as well as tunnel loss, daemon failure, an unauthenticated VPN, IPv4, IPv6 and DNS.

A successful connection check alone does not qualify an image. The guard protects the application
UID; it does not protect against a VM administrator or a compromised kernel.

[Back to the README](../../README.md#reference)
