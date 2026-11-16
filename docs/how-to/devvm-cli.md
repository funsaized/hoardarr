# Use the DevVM CLI

Run `devvm` on the host to manage the VM. Inside its shell, use `sudo hoardarr-operator` for
application commands. The VM image holds code and runtimes; the host project holds configuration,
catalog state and media.

## Select the inventory and project

Hoardarr uses a separate DevVM inventory. In your host terminal, select its project and inventory:

```sh
cd "$HOME/.local/share/hoardarr-devvm"
export PATH="$HOME/.hoardarr-host/tools/bin:$PATH"
export XDG_CONFIG_HOME="$HOME/.hoardarr-host/config"
export XDG_DATA_HOME="$HOME/.hoardarr-host/data"
export DEVVM_LIMA_HOME="$HOME/.hoardarr-lima"
devvm ls
```

If your paths differ, use those in `~/.hoardarr-host/production-deployment.json`. Without these
exports, `devvm ls` reads the default inventory, which may be empty. If a shell environment manager
sets them, check their values after changing directories.

Check that the production row's `FOLDER` matches your current directory. DevVM chooses a VM by
project folder. Running it from the source checkout, usually a different folder, can create another
VM.

Check `command -v devvm` and `devvm --version` against the enrolled executable and
[runtime pins](../../deploy/devvm/pins.json). If your checkout has a local `mise run devvm` task, it
selects the project and inventory for you. For example, run `mise run devvm ls`. This task belongs
to the local setup; the VM image does not include it.

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

Use `exit` to return to the host; the VM keeps running. The guest includes `hoardarr-operator` for
application commands; see [native operations](operate-native.md).

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

Restarting keeps the installed code, and building an image leaves existing VMs unchanged. Follow
[image deployment](operate-native.md#update-code-and-restart) to install a new image and preserve
the guest's installation identity and data.

See DevVM's [command guide](https://devvm.dev/docs/getting-started/commands/) and
[SSH guide](https://devvm.dev/docs/using/ssh/) for more CLI and editor options.

[Back to the README](../../README.md#reference)
