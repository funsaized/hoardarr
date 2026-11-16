#!/usr/bin/env python3
"""Probe operator proxy access and media refusal in a disposable qualification guest."""
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

identity = json.loads(Path('/etc/hoardarr/instance.json').read_text())
if os.geteuid() != 0 or identity['purpose'] != 'qualification':
    sys.exit('Run as root in the disposable qualification installation')
endpoint = urlsplit(sys.argv[1])
if endpoint.hostname != '192.168.5.2' or not endpoint.port:
    sys.exit('Supply the DevVM host proxy URL; credentials are never printed')
probe = '''import socket,sys
try:
 s=socket.create_connection((sys.argv[1],int(sys.argv[2])),3);s.close();print('connected')
except OSError:print('blocked')
'''
base = ['systemd-run', '--wait', '--pipe', '--collect', '--quiet', '-p', 'User='+str(identity['uid']),
        '-p', 'Group='+str(identity['gid']), '-p', 'NoNewPrivileges=yes']
def run(slice_name, code, *args):
    return subprocess.check_output([*base, '--slice='+slice_name, '/usr/bin/python3', '-c', code, *args], text=True).strip()
operator = run('hoardarragent.slice', probe, endpoint.hostname, str(endpoint.port))
media = run('system.slice', probe, endpoint.hostname, str(endpoint.port))
escape = run('system.slice', '''import os
try:
 with open('/sys/fs/cgroup/hoardarragent.slice/cgroup.procs','w') as f:f.write(str(os.getpid()))
 print('escaped')
except PermissionError:print('denied')
''')
passed = operator == 'connected' and media == 'blocked' and escape == 'denied'
print(json.dumps({'operatorProxy':operator,'mediaProxy':media,'mediaCgroupEscape':escape,'passed':passed}))
sys.exit(0 if passed else 1)
