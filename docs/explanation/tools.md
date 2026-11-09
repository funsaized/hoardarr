# Architecture and tools

Hoardarr is a Deno CLI and a collection of Swamp behaviors, reports and workflow generators. You
edit one configuration file; the CLI validates it and generates an installation's definitions. Swamp
runs the resulting DAG and records method outputs. CEL expressions pass those outputs to later
steps.

```text
hoardarr.yaml -> CLI apply -> Swamp behavior definitions + workflow DAG
                                     |
                               typed providers
                  +------------------+--------------------+
                  |                  |                    |
             TMDB / MMS          Torlink             local / SSH
              discovery       search + transfer         delivery
```

The movie and episode catalogs own media decisions and retry state. Providers expose versioned
capabilities for discovery, search, download, network readiness and delivery. A provider call
retains fresh evidence for that call; a failed query cannot silently reuse a previous successful
result. [The provider contract](../providers.md) explains how to add one.

Torlink is a Node application using BitTorrent. Hoardarr patches its persisted queue/history/seed
publication and torrent identity checks. The patch and upstream revision travel with the source.
Swamp provides the scheduler, typed method execution, data history, reports and secret references.
It does not make filesystem writes durable by itself: native storage adds checked publication and
explicit ownership.

Compose supplies an application image and a separate Gluetun gateway. DevVM supplies a disposable
Linux guest whose OS tools, code, extensions and public caches are pinned in a layer. Guest systemd
starts the VPN, firewall guard and application daemons. Host systemd starts just that VM as its
unprivileged owner. Neither deployment needs another cron job to drive media work.
