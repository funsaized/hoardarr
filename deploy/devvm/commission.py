#!/usr/bin/python3
"""Root authorization for a qualified native runtime. Service staging never admits media work."""
import argparse
import hashlib
import json
import uuid
import os
from pathlib import Path
import stat
import subprocess
import sys
sys.path.insert(0, '/opt/hoardarr/deploy/devvm')
from qualification_evidence import validate_evidence

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('phase',choices=['commissioning','production'])
parser.add_argument('--evidence',required=True)
parser.add_argument('--allow-waived-upgrade-checks',action='store_true',help='Honor recorded operator waivers for disruptive checks on a previously commissioned installation')
args=parser.parse_args()
if os.geteuid()!=0:raise RuntimeError('Root must authorize the qualified installation')
identity_path=Path('/etc/hoardarr/instance.json')
info=identity_path.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o022:raise RuntimeError('Untrusted guest identity')
identity=json.loads(identity_path.read_text())
if identity['purpose']!='production':raise RuntimeError('Disposable qualification is never production commissioning')
manifest_path=Path('/etc/hoardarr/runtime-manifest.json')
info=manifest_path.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o022:raise RuntimeError('Untrusted runtime manifest')
manifest_bytes=manifest_path.read_bytes()
manifest_sha=hashlib.sha256(manifest_bytes).hexdigest()
proof_bytes=Path(args.evidence).read_bytes()
proof=json.loads(proof_bytes)
previous_path=Path(identity['projectRoot'])/'state/maintenance/commissioned.json'
previous=json.loads(previous_path.read_text()) if previous_path.exists() else {}
waived=validate_evidence(proof,manifest_sha,identity,previous,args.phase,args.allow_waived_upgrade_checks)
# Verify installed executable/code assets against the immutable layer manifest.
prefixes={'pi/':Path('/opt/hoardarr-pi'),'bin/':Path('/usr/local/bin'),'torlink/':Path('/opt/torlink'),'hoardarr/':Path('/opt/hoardarr'),
          'public-extensions/':Path('/opt/hoardarr-public-extensions'),'deno-cache/':Path('/opt/hoardarr-cache')}
for entry in json.loads(manifest_bytes)['entries']:
    name=entry['path']
    if name.startswith('/') or '..' in name.split('/'):raise RuntimeError('Unsafe runtime manifest entry')
    prefix=next((p for p in prefixes if name.startswith(p)),None)
    if prefix is None:continue
    path=prefixes[prefix]/name[len(prefix):]
    info=path.lstat()
    if info.st_uid!=0:raise RuntimeError('Runtime asset is not root-owned: '+name)
    if 'link' in entry:
        if not path.is_symlink() or os.readlink(path)!=entry['link'] or not path.resolve().is_relative_to(prefixes[prefix]):raise RuntimeError('Runtime link differs: '+name)
    else:
        if info.st_mode & 0o022:raise RuntimeError('Runtime asset is writable by an application group: '+name)
        if not stat.S_ISREG(info.st_mode):raise RuntimeError('Runtime asset is not regular: '+name)
        with path.open('rb') as file:digest=hashlib.file_digest(file,'sha256').hexdigest()
        if digest!=entry['sha256']:raise RuntimeError('Installed runtime differs from qualified source: '+name)
ready=json.loads(subprocess.check_output(['/usr/local/libexec/hoardarr-vpn-status'],timeout=10))
if any(ready.get(key) is not True for key in ['authenticated','connected','firewall','killswitch','autoconnect','interfaceUp','guardReady']) or ready['interface']!=identity['vpnInterface']:
    raise RuntimeError('Fresh protected VPN readiness is required for commissioning')
# Re-entering a stage cannot silently reopen admissions. Existing ownership must be recovered separately.
project=Path(identity['projectRoot'])
maintenance=project/'state/maintenance'
if (maintenance/'ownership/lease.json').exists():raise RuntimeError('Existing ownership must finish or recover before commissioning')
if json.loads((maintenance/'ownership/admission.json').read_text()).get('inhibited') is not True:raise RuntimeError('Inhibit admissions before commissioning')
value={'schemaVersion':1,'installationId':identity['installationId'],
       'machineId':Path('/etc/machine-id').read_text().strip(),
       'qualificationSha256':hashlib.sha256(proof_bytes).hexdigest(),
       'runtimeManifestSha256':manifest_sha,'phase':args.phase,'waivedGates':waived}
def publish(path,data,mode):
    temporary=path.with_name(path.name+'.'+str(uuid.uuid4())+'.pending')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,'w') as file:
        json.dump(data,file,indent=2);file.write('\n');file.flush();os.fsync(file.fileno())
    os.replace(temporary,path)
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)
publish(maintenance/'commissioned.json',value,0o600)
publish(Path('/etc/hoardarr/commissioned.json'),value,0o644)
print(json.dumps({'authorizedPhase':args.phase,'installationId':identity['installationId'],'admissions':'remain inhibited','waivedGates':waived}))
