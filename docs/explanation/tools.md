# Architecture and tools

You edit `hoardarr.yaml`. The Deno CLI checks that configuration and creates the Swamp definitions
for your installation. Swamp runs the workflow and records each method's output; CEL expressions
pass those results to the next step.

```text
hoardarr.yaml -> CLI apply -> Swamp behavior definitions + workflow DAG
                                     |
                               typed providers
                  +------------------+--------------------+
                  |                  |                    |
             TMDB / MMS          Torlink             local / SSH
              discovery       search + transfer         delivery
```

## Catalogs and providers

The movie and episode catalogs track media decisions and retries. Providers do the outside work:
discovery, search, downloading, network checks and delivery. Their capabilities have versioned
contracts, so you can replace a provider without rewriting the catalog.

Each call keeps its own evidence. A failed query cannot reuse an earlier successful result. See the
[provider contract](../providers.md) to add an implementation.

## The runtimes

Torlink is a Node application that uses BitTorrent. Hoardarr patches how it saves queue, history and
seed state, and how it checks torrent identities. The source includes that patch and its upstream
revision.

Swamp supplies scheduling, typed method calls, data history, reports and secret references. Native
storage adds durable file publication and explicit ownership to protect writes across interruptions.

Compose runs the application image beside a Gluetun VPN gateway. DevVM uses a disposable Linux guest
with pinned tools, code, extensions and public caches.

## What starts what

Guest systemd starts the VPN, firewall guard and application daemons. Host systemd starts one VM as
its unprivileged owner. Swamp schedules the media work inside the running application; neither setup
needs an extra cron job.

[Back to the README](../../README.md#reference)
