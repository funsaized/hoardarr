# Build and provision a native DevVM

This is an advanced source build for Linux x86-64 with KVM, systemd and Btrfs project storage. It
preserves host networking and puts NordVPN, Torlink and Swamp in a disposable Ubuntu guest. Use
[Compose](compose.md) if you want the shorter installation path.

The kit does not ship a preconfigured VM disk. Build a public layer, create a disposable
qualification VM, test it, and then provision production with separate credentials. Allow time for
the [qualification gates](../reference/qualification.md), including a physical host reboot and
restore.

## Acquire build inputs

Use the exact revisions in [`pins.json`](../../deploy/devvm/pins.json). Install DevVM from its
[pinned source](https://github.com/devvmhq/devvm/tree/e9bd270398730bf0f7ffe44e8f78f5da323daeb7),
Lima 2.3.0, Node 22.21.1 and Deno 2.9.8. Keep DevVM's config/data directories separate from other
VMs. Its Ubuntu base must match the pinned release and the base package versions in
`deploy/devvm/base-dependencies.json`.

Download the Swamp derivative binary and complete corresponding source archive from the Hoardarr
release. Keep them as `swamp-hoardarr` and `swamp-hoardarr-source.tar.gz` in an artifacts directory.
Also download the official Deno Linux x86-64 zip as `deno.zip` and Node Linux x64 tar.xz as
`node.tar.xz`. The layer builder checks all four against the published SHA-256 pins. The derivative
source contains the modified Swamp source and build tasks; its patch is also in
`deploy/devvm/patches`.

Acquire the OS packages listed in `deploy/devvm/package-checks.json` from authenticated Ubuntu and
NordVPN package repositories on an Ubuntu 26.04 build guest. For each row, use
`apt-get download PACKAGE=VERSION`. Retain the `.deb` files in a private package directory; the
builder checks the signed-index digests retained in the lock. A changed or unavailable package is a
new build input requiring an explicit pin update and qualification, not a reason to disable
checking. Never export packages, caches or runtime trees from a credentialed production guest.

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

The export builder needs registry authentication for the pinned public extensions. It builds patched
Torlink and creates a fresh dependency cache; only public code, checked packages and caches enter
`export.tar`. Review it before redistribution. The work directory itself is private and is never a
release artifact. `prepare-layer.py` emits `runtime.tar.gz`, `hoardarr.sh` and `hoardarr.policy`.

Register the generated script/policy under DevVM's isolated `devvm/layers` configuration directory,
and select `hoardarr` as the layer when creating a new project VM. DevVM's
[image and layer guide](https://github.com/devvmhq/devvm/blob/v0.1.0/docs/content/docs/using/images.md)
describes the storage layout. Serve only `runtime.tar.gz` at the pinned URL while building. The host
lifecycle helper later serves that one checked archive on loopback for remakes. Keep the archive and
DevVM image/package caches with the recovery kit.

## Provision a fresh guest

Create a mode-700 persistent project owned by the unprivileged operator, shared through 9p at the
same absolute path in the guest. Use a separate project for qualification. Generate an RSA recovery
key on the physical host; the private key stays there. Transfer only its public key to the guest.

In the guest management shell:

```sh
sudo /usr/local/sbin/hoardarr-provision fresh \
  --project /ABSOLUTE/SHARED/PROJECT --purpose qualification \
  --public-key /private/recovery-public.pem
```

Provisioning generates root identity, storage markers, the ext4 control checkout, disabled media
services and read-only observation sockets. It leaves admissions inhibited. Store the Swamp
`key`/`signinToken` JSON in the project's private `secrets/swamp.json`, owned by the service UID and
mode 600. Add the TMDB key through `sudo hoardarr-operator swamp vault put hoardarr TMDB_API_KEY`.
Authenticate/configure NordVPN as root using its supported account flow. Never place account tokens
in layer scripts. The generated native profile expects OpenVPN TCP and `nordtun`; firewall, kill
switch and autoconnect must remain enabled.

Run the disposable qualification matrix and synthetic acquisition, backup, remake and restore
checks. For production, repeat fresh provisioning in a different project with
`--purpose production`, fresh identity and its own credentials. Stage commissioning only with
evidence for that exact manifest.

## Enroll the host and install boot startup

After production provisioning, record the actual VM name, paths and recovery assets:

```sh
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

Enrollment verifies the guest/storage/recovery-key identities and writes a new private deployment
record plus persistent host helpers. It refuses to replace an existing enrollment. It does not open
admissions or install a service.

Render the host unit, inspect it, then install the exact reviewed unit:

```sh
mkdir -p "$HOME/.hoardarr-host/reviewed"
python3 deploy/devvm/install-host.py --operator-uid "$(id -u)" --render \
  > "$HOME/.hoardarr-host/reviewed/hoardarr-devvm.service"
cat "$HOME/.hoardarr-host/reviewed/hoardarr-devvm.service"
sudo python3 deploy/devvm/install-host.py --operator-uid "$(id -u)"
```

The unit starts one VM as the operator and verifies its readiness. It does not alter physical host
VPN/Tailscale configuration or enable media scheduling. Complete G6 and production commissioning
before opening admissions. Keep the first production schedule disabled until a manual run is
verified.
