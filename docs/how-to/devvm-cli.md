# Use the DevVM CLI

Use `devvm` on the physical host to list VMs, open a guest shell and manage a VM's lifecycle. The
Hoardarr image supplies the application, runtimes and native provisioning tools. The persistent
project supplies installation configuration, credentials, catalog state and media. Runtime updates
replace the guest through DevVM; routine operation does not patch application files in the guest.

Inside the guest, use `sudo hoardarr-operator` for application work and `sudo systemctl` for guest
services. The [native build guide](native-devvm.md) covers creating and commissioning an
installation.

## Select the inventory and project

Hoardarr keeps a separate DevVM inventory. In your host terminal, change to the persistent project
directory, then export its configuration and data directories:

```sh
cd "$HOME/.local/share/hoardarr-devvm"
export XDG_CONFIG_HOME="$HOME/.hoardarr-host/config"
export XDG_DATA_HOME="$HOME/.hoardarr-host/data"
devvm ls
```

Use the actual paths from your private `~/.hoardarr-host/production-deployment.json` if enrollment
used different directories. A shell environment manager may already supply the exports; check them
after changing directories. Without those exports, `devvm ls` lists the default inventory, which may
be empty.

Find the production row and check its `FOLDER` against your current directory. DevVM selects a VM
from the folder you are in; the Hoardarr source checkout and the persistent VM project are usually
different folders. Running `devvm` in a folder without an existing VM starts creation of a new one.

Use the pinned DevVM executable recorded at enrollment. Check `command -v devvm` and
`devvm --version` against the [runtime pins](../../deploy/devvm/pins.json). Enrollment's host boot
helper also verifies the executable checksum and storage identities.

## Open the guest shell

From the verified project folder on the host:

```sh
devvm
```

DevVM starts the selected VM if needed and opens a management shell at the shared project path. Run
the guest commands in [native operations](operate-native.md) there:

```sh
sudo hoardarr-operator status
sudo hoardarr-operator plan
```

Use `exit` to return to the host. The VM continues running. For SSH or editor access, `devvm host`
prints the management hostname; see DevVM's [SSH guide](https://devvm.dev/docs/using/ssh/).

## Manage the VM

Run these on the host with the same inventory exports. Commands affecting a VM use the current
project folder:

| Task                             | Command                  |
| -------------------------------- | ------------------------ |
| List VMs and their folders       | `devvm ls`               |
| Open the project's guest shell   | `devvm`                  |
| Prepare access and show hostname | `devvm host`             |
| Stop the project's VM            | `devvm stop`             |
| Restart it and open a shell      | `devvm restart`          |
| Inspect registered images        | `devvm images`           |
| Build the Hoardarr image         | `devvm build hoardarr`   |
| Rebuild the Hoardarr image       | `devvm rebuild hoardarr` |
| Deploy the rebuilt image         | `devvm update`           |

Before stopping or restarting a production VM, open its guest shell, inhibit admissions, and wait
for `lease: null`:

```sh
sudo hoardarr-operator inhibit --reason "VM maintenance"
sudo hoardarr-operator status
```

Then stop the application writers and return to the host:

```sh
sudo systemctl stop hoardarr-swamp.service hoardarr-torlink.service
exit
```

Run the selected `devvm stop` or `devvm restart` command on the host. After starting the VM and
opening its shell again, verify readiness and reopen admissions using the
[native operations procedure](operate-native.md#resume-after-vm-maintenance). Admissions remain
closed across a restart.

## Update or recover a runtime

`devvm restart` keeps the installed guest disk and code. A new Hoardarr revision needs an updated
native runtime and generated definitions; follow
[code updates](operate-native.md#update-code-and-restart).

`devvm rebuild hoardarr` builds a new image without replacing existing VMs. `devvm update` can
replace the selected VM's disk with that image, preserving the project and home directories. Perform
that cutover through [backup and recovery](backup-and-recovery.md#rebuild-the-guest), including root
credential recovery and qualification of the replacement guest.

The build scripts prepare verified runtime assets, enrollment records recovery identities, and the
host backup helper exports a complete application snapshot. Their commands remain in the respective
guides. The optional enrolled `hoardarr-host-operator` helper supports scripted application calls;
interactive operation uses the `devvm` guest shell above.

See DevVM's [command guide](https://devvm.dev/docs/getting-started/commands/) for the complete CLI.

[Back to the README](../../README.md#reference)
