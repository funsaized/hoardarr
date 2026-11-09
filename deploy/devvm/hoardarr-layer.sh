#!/usr/bin/env bash
# Prepend HOARDARR_BUNDLE_URL and HOARDARR_BUNDLE_SHA256 to the registered DevVM layer.
# The archive contains only pinned public runtime assets. Provision identity and credentials later.
set -euo pipefail
: "${HOARDARR_BUNDLE_URL:?Supply the public bundle URL}"
: "${HOARDARR_BUNDLE_SHA256:?Supply the pinned public archive SHA256}"
test "$(uname -m)" = x86_64
test ! -e /etc/hoardarr/instance.json
source /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 26.04
hoardarr_layer_tmp=$(mktemp -d)
trap 'rm -rf "$hoardarr_layer_tmp"' EXIT
HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= http_proxy= https_proxy= all_proxy= \
  devvm-fetch "$HOARDARR_BUNDLE_URL" "$HOARDARR_BUNDLE_SHA256" "$hoardarr_layer_tmp/runtime.tar.gz"
tar -xzf "$hoardarr_layer_tmp/runtime.tar.gz" -C "$hoardarr_layer_tmp"
python3 "$hoardarr_layer_tmp/runtime/bundle-manifest.py" verify "$hoardarr_layer_tmp/runtime"
# Fail if a required dependency supplied by the pinned base image drifted.
python3 - "$hoardarr_layer_tmp/runtime/base-dependencies.json" <<'PY'
import json,subprocess,sys
for package,version in json.load(open(sys.argv[1])).items():
    actual=subprocess.check_output(['dpkg-query','--show','--showformat=${Version}',package],text=True)
    if actual!=version:raise RuntimeError('Unqualified base package: '+package)
PY
python3 - "$hoardarr_layer_tmp/runtime" > "$hoardarr_layer_tmp/needed-packages" <<'PY'
import json,pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1])
for item in json.loads((root/'package-checks.json').read_text()):
    installed=subprocess.run(['dpkg-query','--show','--showformat=${db:Status-Abbrev} ${Version}',item['package']],capture_output=True,text=True)
    if installed.returncode or installed.stdout!='ii  '+item['version']:
        sys.stdout.buffer.write(str(root/'packages'/item['file']).encode()+b'\0')
PY
mapfile -d '' hoardarr_layer_packages < "$hoardarr_layer_tmp/needed-packages"
if ((${#hoardarr_layer_packages[@]})); then
  sudo env DEBIAN_FRONTEND=noninteractive dpkg -i "${hoardarr_layer_packages[@]}"
fi
sudo systemctl disable --now nordvpnd.socket nordvpnd.service nordvpnd-killswitch.service
sudo python3 - "$(id -un)" <<'PY'
import grp,subprocess,sys
if sys.argv[1] in grp.getgrnam('nordvpn').gr_mem:
    subprocess.run(['gpasswd','-d',sys.argv[1],'nordvpn'],check=True)
PY
# No account was provisioned in this image. A remake rehydrates encrypted recovery state separately.
sudo rm -rf /var/lib/nordvpn /root/.config/nordvpn
sudo install -m 755 "$hoardarr_layer_tmp/runtime/bin/"{node,deno,swamp} /usr/local/bin/
sudo install -m 644 "$hoardarr_layer_tmp/runtime/swamp-source.tar.gz" /opt/hoardarr-swamp-source.tar.gz
sudo install -d -m 755 /usr/share/hoardarr
sudo cp -a "$hoardarr_layer_tmp/runtime/licenses" /usr/share/hoardarr/licenses
sudo chown -R root:root /usr/share/hoardarr/licenses
sudo chmod -R a+rX,go-w /usr/share/hoardarr/licenses
sudo cp -a "$hoardarr_layer_tmp/runtime/torlink" /opt/torlink
sudo cp -a "$hoardarr_layer_tmp/runtime/hoardarr" /opt/hoardarr
sudo cp -a "$hoardarr_layer_tmp/runtime/public-extensions" /opt/hoardarr-public-extensions
sudo cp -a "$hoardarr_layer_tmp/runtime/deno-cache" /opt/hoardarr-cache
# The public archive is extracted by the image builder's unprivileged user.
# cp -a preserves that owner, so explicitly seal every runtime tree before use.
sudo chown -R --no-dereference root:root /opt/torlink /opt/hoardarr /opt/hoardarr-public-extensions /opt/hoardarr-cache
sudo chmod -R a+rX,go-w /opt/torlink /opt/hoardarr /opt/hoardarr-public-extensions /opt/hoardarr-cache
sudo install -m 755 /opt/hoardarr/deploy/devvm/exec.py /usr/local/libexec/hoardarr-exec
sudo install -m 755 /opt/hoardarr/deploy/devvm/vpn-status.py /usr/local/libexec/hoardarr-vpn-status
sudo install -m 755 /opt/hoardarr/deploy/devvm/maintenance-status.py /usr/local/libexec/hoardarr-maintenance-status
sudo install -m 755 /opt/hoardarr/deploy/devvm/egress-guard.py /usr/local/libexec/hoardarr-egress-guard
sudo install -m 755 /opt/hoardarr/deploy/devvm/recovery-capsule.py /usr/local/libexec/hoardarr-recovery-capsule
sudo install -m 755 /opt/hoardarr/deploy/devvm/provision.py /usr/local/sbin/hoardarr-provision
sudo install -m 755 /opt/hoardarr/deploy/devvm/commission.py /usr/local/sbin/hoardarr-commission
sudo install -m 755 /opt/hoardarr/deploy/devvm/rehydrate.py /usr/local/sbin/hoardarr-rehydrate
sudo install -m 755 /opt/hoardarr/deploy/devvm/native_operator.py /usr/local/sbin/hoardarr-operator
sudo install -m 644 /opt/hoardarr/deploy/devvm/hoardarr-egress-guard.service /etc/systemd/system/
sudo install -D -m 644 /opt/hoardarr/deploy/devvm/nordvpnd-killswitch-ordering.conf /etc/systemd/system/nordvpnd-killswitch.service.d/hoardarr-ordering.conf
sudo mkdir -p /etc/hoardarr
sudo install -m 644 /opt/hoardarr/deploy/devvm/resolv.conf /etc/hoardarr/resolv.conf
sudo install -m 644 "$hoardarr_layer_tmp/runtime/bundle-manifest.json" /etc/hoardarr/runtime-manifest.json
sudo install -m 644 "$hoardarr_layer_tmp/runtime/package-versions.json" /etc/hoardarr/package-versions.json
sudo python3 - /etc/hoardarr/package-versions.json <<'PY'
import json,subprocess,sys
for package,version in json.load(open(sys.argv[1])).items():
    actual=subprocess.check_output(['dpkg-query','--show','--showformat=${Version}',package],text=True)
    if actual!=version:raise RuntimeError('Runtime package version differs: '+package)
PY
sudo systemctl daemon-reload
# Every application service stays absent/disabled until explicit per-installation provisioning.
