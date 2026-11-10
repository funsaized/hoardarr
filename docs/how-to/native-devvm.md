# Build and provision a native DevVM

This is the image builder and initial installation guide. For an existing installation, use
[DevVM startup](devvm-cli.md) and [native operations](operate-native.md).

This build puts NordVPN, Torlink and Swamp in a disposable Ubuntu guest while preserving host
networking. It needs Linux x86-64, KVM, systemd and Btrfs project storage. [Compose](compose.md) has
a shorter installation path.

You'll build a public layer, test a disposable qualification VM, then provision production with
separate credentials. There is no preconfigured VM disk. Allow time for the
[qualification gates](../reference/qualification.md), including a physical host reboot and restore.

## 1. Prepare the build environment

Use the exact revisions in [`pins.json`](../../deploy/devvm/pins.json). Install DevVM from its
[pinned source](https://github.com/devvmhq/devvm/tree/e9bd270398730bf0f7ffe44e8f78f5da323daeb7),
Lima 2.3.0, Node 22.21.1 and Deno 2.9.8. Keep DevVM's config/data directories separate from other
VMs. From the source checkout on the physical host, select that isolated inventory:

```sh
export XDG_CONFIG_HOME="$HOME/.hoardarr-host/config"
export XDG_DATA_HOME="$HOME/.hoardarr-host/data"
devvm --version
devvm doctor
devvm ls
```

Keep these exports in the host terminal used for the build. The [DevVM CLI guide](devvm-cli.md)
explains inventory and project selection. Its Ubuntu base must match the pinned release and the base
package versions in `deploy/devvm/base-dependencies.json`.

## 2. Acquire the runtime files

Download the Swamp derivative binary and complete corresponding source archive from the Hoardarr
release. Keep them as `swamp-hoardarr` and `swamp-hoardarr-source.tar.gz` in an artifacts directory.
Also download the official Deno Linux x86-64 zip as `deno.zip` and Node Linux x64 tar.xz as
`node.tar.xz`. The layer builder checks all four against the published SHA-256 pins. The derivative
source contains the modified Swamp source and build tasks. Its patch is also in
`deploy/devvm/patches`.

## 3. Acquire OS packages

Acquire the OS packages listed in `deploy/devvm/package-checks.json` from authenticated Ubuntu and
NordVPN package repositories on an Ubuntu 26.04 build guest. For each row, use
`apt-get download PACKAGE=VERSION`. Retain the `.deb` files in a private package directory; the
builder checks them against the signed-index digests in the lock.

If a package changes or becomes unavailable, update its pin explicitly and qualify the new input.
Keep checksum checking enabled. Never export packages, caches or runtime trees from a credentialed
production guest.

## 4. Build and register the layer

Create a fresh public export and layer:

```sh
python3 deploy/devvm/build-public-export.py \
  --work /private/build/inputs \
  --packages /private/build/packages \
  --swamp /private/build/artifacts/swamp-hoardarr
python3 deploy/devvm/prepare-layer.py \
  --public-export /private/build/inputs/export.tar \
  --artifacts /private/build/artifacts \
  --output /private/build/layer \
  --bundle-url http://host.lima.internal:18765/runtime.tar.gz
```

The export builder uses registry authentication to pull the pinned public extensions. It builds
patched Torlink and a fresh dependency cache. `export.tar` contains only public code, checked
packages and caches; review it before redistribution. Keep the work directory private.

`prepare-layer.py` produces `runtime.tar.gz`, `hoardarr.sh` and `hoardarr.policy`.

Register the generated script/policy in the selected DevVM inventory:

```sh
install -d -m 700 "$XDG_CONFIG_HOME/devvm/layers"
install -m 700 /private/build/layer/hoardarr.sh "$XDG_CONFIG_HOME/devvm/layers/hoardarr.sh"
install -m 600 /private/build/layer/hoardarr.policy "$XDG_CONFIG_HOME/devvm/layers/hoardarr.policy"
```

Serve only `runtime.tar.gz` at the pinned URL while building, then use the CLI:

```sh
devvm build hoardarr
devvm images
```

DevVM's [image guide](https://devvm.dev/docs/using/images/) describes the image chain. For a changed
layer, `devvm rebuild hoardarr` rebuilds the image; existing VMs keep their installed runtime until
an explicit update. The enrolled host lifecycle helper serves the one checked archive on loopback
for remakes. Keep the archive and DevVM image/package caches with the recovery kit.

## 5. Provision a qualification guest

Create a new mode-700 persistent project owned by the unprivileged operator. Use a separate project
for qualification. On the physical host, replace the absolute path below with that new directory:

```sh
mkdir -m 700 /ABSOLUTE/SHARED/QUALIFICATION
cd /ABSOLUTE/SHARED/QUALIFICATION
export XDG_CONFIG_HOME="$HOME/.hoardarr-host/config"
export XDG_DATA_HOME="$HOME/.hoardarr-host/data"
devvm --layers hoardarr --tools none --agents none --network open --ports none --no-git-protect --no-input
```

DevVM creates the guest, shares this project through 9p at the same absolute path and opens its
management shell. All following provisioning and application commands run inside that shell.
Generate an RSA recovery key on the physical host; the private key stays there. Transfer only its
public key to the guest, for example through the shared project.

In the guest management shell:

```sh
sudo /usr/local/sbin/hoardarr-provision fresh \
  --project /ABSOLUTE/SHARED/PROJECT --purpose qualification \
  --public-key /private/recovery-public.pem
```

Provisioning creates the root identity, storage markers, ext4 control checkout and read-only
observation sockets. It leaves media services disabled and admissions closed.

## 6. Add credentials and qualify

Save the Swamp `key`/`signinToken` JSON in the project's private `secrets/swamp.json`, owned by the
service UID with mode 600. Add the TMDB key through
`sudo hoardarr-operator swamp vault put hoardarr TMDB_API_KEY`.

Authenticate and configure NordVPN as root through its supported account flow. Keep tokens out of
layer scripts. The generated profile expects OpenVPN TCP and `nordtun`, with the firewall, kill
switch and autoconnect enabled.

Run the disposable network matrix and the synthetic acquisition, backup, remake and restore checks.
Then exit to the host, create a different persistent production project, and run the same `devvm`
creation command from that folder with the same inventory exports. The examples in the operations
guide use `$HOME/.local/share/hoardarr-devvm` for this project. Repeat fresh provisioning in its
guest shell with `--purpose production`, a fresh identity and its own credentials. Commission only
with evidence for that exact runtime manifest.

## 7. Enroll the production host

After production provisioning, exit the guest and return to the source checkout on the host.
`devvm ls` shows the actual VM name and persistent folder to record with the recovery assets:

```sh
devvm ls
python3 deploy/devvm/enroll-host.py \
  --devvm /ABSOLUTE/PATH/TO/devvm \
  --project "$HOME/.local/share/hoardarr-devvm" \
  --config-home "$HOME/.hoardarr-host/config" \
  --data-home "$HOME/.hoardarr-host/data" \
  --vm ACTUAL_DEVVM_NAME \
  --backup-root /PRIVATE/SEPARATE/BACKUPS \
  --recovery-key /PRIVATE/RECOVERY/private.pem \
  --runtime-bundle /PRIVATE/BUILD/layer/runtime.tar.gz
```

Enrollment checks the guest, storage and recovery-key identities, then writes a private deployment
record and persistent host helpers. It refuses to replace an existing enrollment, leaves admissions
closed and does not install a service.

## 8. Review the boot service

Render the host unit, inspect it, then install that exact unit:

```sh
mkdir -p "$HOME/.hoardarr-host/reviewed"
python3 deploy/devvm/install-host.py --operator-uid "$(id -u)" --render \
  > "$HOME/.hoardarr-host/reviewed/hoardarr-devvm.service"
cat "$HOME/.hoardarr-host/reviewed/hoardarr-devvm.service"
sudo python3 deploy/devvm/install-host.py --operator-uid "$(id -u)"
```

The unit starts one VM through the enrolled DevVM lifecycle helper as the operator and checks its
readiness. Physical host VPN/Tailscale settings stay as they are, and media scheduling stays off.

Complete G6 and production commissioning, then follow
[resume after VM maintenance](operate-native.md#resume-after-vm-maintenance) to enable and start the
guest application services. Verify a manual run before enabling the first production schedule.
Subsequent starts use `devvm`; the enabled services start with the guest.

[Back to the README](../../README.md#reference)
