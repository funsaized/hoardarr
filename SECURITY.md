# Security

Report vulnerabilities through the repository's private GitHub security reporting channel when it is
available. If it is unavailable, contact the maintainer through their GitHub profile to arrange a
private report before sending details. Do not put credentials, acquisition locators or private logs
in a public issue.

Hoardarr protects against accidental overlap, stale provider evidence, conflicting destination
files, unsafe path traversal, missing native storage and application egress outside the selected VPN
boundary. It does not treat root, a compromised VM kernel, the Docker daemon or the host
administrator as untrusted. VPN use also does not make acquired content trustworthy.

Keep control APIs on loopback. Use the management transport for operations. Application containers
run without capabilities; only the VPN gateway needs network administration privileges. Native
application processes run as an unprivileged UID without the NordVPN control group. Root helpers
have narrow provisioning, observation and recovery duties.

Use private secret files or vault prompts. Prefer scoped, expiring Swamp credentials appropriate to
the installation. Public images contain code and dependencies, never operator credentials. Backups,
semantic inventories and diagnostic captures are private and need access control and retention
rules.

Dependency pins make a build inspectable, but do not provide automatic security updates. Review
upstream fixes, rebuild, run checks and repeat native qualification for a changed runtime. A failed
native preflight must leave admissions closed. Avoid bypassing checks to restore availability; use
the recovery procedures and preserve evidence of incomplete operations.
