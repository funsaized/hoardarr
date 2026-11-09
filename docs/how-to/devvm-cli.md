# Use the DevVM CLI

Manage the native VM with `devvm` on the physical host. Run application commands with
`sudo hoardarr-operator` inside its guest shell. The image supplies application code and runtimes;
the persistent project holds configuration, catalog state and media.

## Select the inventory and project

Hoardarr has a separate DevVM inventory. In your host terminal, change to the persistent project
first, then select that inventory:

```sh
cd "$HOME/.local/share/hoardarr-devvm"
export XDG_CONFIG_HOME="$HOME/.hoardarr-host/config"
export XDG_DATA_HOME="$HOME/.hoardarr-host/data"
devvm ls
```

Use your enrolled paths from `~/.hoardarr-host/production-deployment.json` if they differ. Without
these exports, `devvm ls` uses the default inventory, which may be empty. Check the exports after
changing directories if a shell environment manager supplies them.

Check that the production row's `FOLDER` matches your current directory. DevVM selects a VM by
project folder. The source checkout is usually a different folder; running `devvm` there can create
another VM.

Use the pinned executable recorded at enrollment; `command -v devvm` and `devvm --version` should
match the [runtime pins](../../deploy/devvm/pins.json). If your checkout already has the local
`mise run devvm` task, it selects the enrolled inventory and project for you; for example,
`mise run devvm ls`. That task is local setup, not part of the shipped image.

## Open the guest shell

On the host, from the selected project:

```sh
devvm
```

This starts the VM if needed and opens its shell. Enabled services start with the guest. Check them
inside that shell:

```sh
sudo systemctl is-active hoardarr-swamp.service hoardarr-torlink.service
sudo hoardarr-operator status
```

Use `exit` to return to the host; the VM keeps running. `hoardarr-operator` is installed inside the
guest. For application commands, see [native operations](operate-native.md).

## Manage the VM

Run these on the host with the selected inventory and project:

| Task                             | Command                  |
| -------------------------------- | ------------------------ |
| List VMs and their folders       | `devvm ls`               |
| Start the VM and open its shell  | `devvm`                  |
| Prepare access and show hostname | `devvm host`             |
| Stop the VM                      | `devvm stop`             |
| Restart it using the same disk   | `devvm restart`          |
| Inspect registered images        | `devvm images`           |
| Build the Hoardarr image         | `devvm build hoardarr`   |
| Rebuild the Hoardarr image       | `devvm rebuild hoardarr` |
| Replace the guest from its image | `devvm update`           |

Before a production stop or restart, [pause work](operate-native.md#pause-for-maintenance).
Afterward, [resume admissions](operate-native.md#resume-after-vm-maintenance).

A restart keeps the installed code. Building an image does not update existing VMs. Follow
[image deployment](operate-native.md#update-code-and-restart) to replace a guest while preserving
its installation identity and data.

See DevVM's [command guide](https://devvm.dev/docs/getting-started/commands/) and
[SSH guide](https://devvm.dev/docs/using/ssh/) for more CLI and editor options.

[Back to the README](../../README.md#reference)
