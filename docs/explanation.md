# Explanations

The design explanations now have separate pages for [tools](explanation/tools.md),
[networking](explanation/networking.md), [storage](explanation/storage.md), and
[scheduling](explanation/scheduling.md). See the [documentation index](README.md) for tutorials and
operator references.

## Operator and media networking

DevVM supplies Pi and keeps provider API keys on the host. The interactive operator runs in a
root-managed cgroup that can reach DevVM's proxy. The application UID still matches the 9p share
owner: a different UID cannot reopen its own private files on this host's share. Media processes
remain outside the operator cgroup, under the VPN-only UID guard. Root creates the operator cgroup
without delegation; application commands run in separate system services with privilege escalation
disabled. Pi retains management privileges and can perform authorized administration.
