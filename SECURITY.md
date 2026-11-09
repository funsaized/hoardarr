# Security

Report vulnerabilities through the repository's private GitHub security reporting channel when it is
available. Otherwise, contact the maintainer through their GitHub profile to arrange a private
report. Keep credentials, acquisition locators and private logs out of public issues.

## Runtime boundaries

Hoardarr checks for overlapping runs, stale provider evidence, conflicting destination files, unsafe
paths and missing native storage. It also restricts application traffic to the selected VPN
boundary.

Root, the Docker daemon, the host administrator and a compromised VM kernel are outside that
boundary. Using a VPN does not make downloaded content trustworthy.

Keep control APIs on loopback and use the management transport for operations. Application
containers run without capabilities; only the VPN gateway needs network administration privileges.

Native applications run as an unprivileged UID without the NordVPN control group. Root helpers
handle narrowly scoped provisioning, observation and recovery tasks.

## Credentials and private data

Use private secret files or vault prompts. Prefer scoped, expiring Swamp credentials suited to the
installation. Public images contain code and dependencies, never operator credentials.

Backups, inventories and diagnostic captures can contain private data. Control access and set a
retention policy for them.

## Updates and recovery

Pins let you inspect a build; they do not install security updates. Review upstream fixes, rebuild
and run the checks. Repeat native qualification when the runtime changes.

A failed native preflight must leave admissions closed. Use the recovery procedures and preserve
records of incomplete work rather than bypassing the checks to restart a service.

[Back to the README](README.md#reference)
