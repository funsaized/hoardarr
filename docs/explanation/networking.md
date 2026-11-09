# Networking

Readiness checks answer whether a VPN is usable now. A firewall controls where packets can go after
a check has passed. Hoardarr uses both because a connection can fail between preflight and a peer
request.

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

In Compose, Hoardarr's search and Torlink's daemon share Gluetun's network namespace. Only Gluetun
gets `NET_ADMIN`; application containers drop capabilities. Control APIs bind to loopback, and the
Compose file publishes no ports. Docker exec remains available when the VPN fails. IPv6 is disabled
for this profile, and resolver configuration must not bypass the tunnel through Docker's DNS proxy.

In the native VM, the application UID cannot control NordVPN. A root-owned status broker reports VPN
readiness, and a separate UID firewall guard restricts application egress. The application launcher
constructs a clean environment without inherited proxy variables or shell startup hooks. It binds
Torlink to the selected tunnel interface. Management traffic uses a separate identity so operators
can diagnose a disconnected VPN.

DevVM's host proxy and local relay are potential alternate egress paths. They are covered by the
native qualification matrix, alongside tunnel loss, daemon failure, unauthenticated VPN state, IPv4,
IPv6 and DNS. A passing connectivity check alone does not qualify an image. The guard protects the
application UID; VM administrators and a compromised kernel remain outside that boundary.

The native deployment changes networking inside the guest. It does not need to switch the physical
host's VPN or Tailscale routing to deliver to its local library.
