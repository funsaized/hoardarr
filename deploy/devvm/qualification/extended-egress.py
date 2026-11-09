#!/usr/bin/python3
"""Disposable guest qualification only: route/proxy/unauthenticated and daemon fault cases."""
import argparse,json,os,re,shutil,socket,struct,subprocess,time,urllib.parse
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--with-torlink',action='store_true')
parser.add_argument('--dht-port',type=int,default=49161)
parser.add_argument('--run-name',default='extended-egress')
args=parser.parse_args()
identity=json.loads(Path('/etc/hoardarr/instance.json').read_text())
if identity.get('purpose')!='qualification':raise RuntimeError('Fault injection requires a disposable qualification identity')
if not re.fullmatch('[a-z0-9-]+',args.run_name):raise RuntimeError('Invalid qualification run name')
project=Path(identity['projectRoot']);root=project/'evidence'/args.run_name
if args.run_name!='extended-egress' and root.exists():raise RuntimeError('Use a new evidence directory for each fault matrix')
root.mkdir(parents=True,exist_ok=True)
if (project/'state/maintenance/ownership/lease.json').exists():raise RuntimeError('Finish or recover the existing owner before fault testing')
if json.loads((project/'state/maintenance/ownership/admission.json').read_text()).get('inhibited') is not True:raise RuntimeError('Inhibit media admissions before fault testing')
for unit in ['hoardarr-swamp.service']+([] if args.with_torlink else ['hoardarr-torlink.service']):
 if subprocess.check_output(['systemctl','show',unit,'-p','ActiveState','--value']).strip() not in [b'inactive',b'failed']:raise RuntimeError('Stop media services before extended probes')
def run(args,**kwargs):return subprocess.run(args,check=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120,**kwargs)
proxy=urllib.parse.urlsplit(os.environ.get('HTTP_PROXY') or os.environ.get('http_proxy',''))
if not proxy.hostname or not proxy.port:raise RuntimeError('Observe the actual DevVM host proxy in the management environment first')
relay=urllib.parse.urlsplit(subprocess.check_output(['/usr/local/bin/devvm-local-proxy','url'],text=True).strip())
# Start the vendor-supplied local relay under root solely as an adversarial bypass target.
relay_pid=None
ipv6_source='fd42:6465:7676::2';ipv6_target='fd42:6465:7676::1'
ipv6_settings={key:Path('/proc/sys/net/ipv6/conf/'+key+'/disable_ipv6').read_text().strip() for key in ['all','eth0']}
route_added=False;cap=None;probe_started=False;counter_result=None;saved=Path('/var/lib/nordvpn.qualification-preserved')
def counters():
 rules=json.loads(subprocess.check_output(['nft','-j','list','table','inet','hoardarr_qualification']))['nftables']
 return {r['rule']['comment']:next(e['counter']['packets'] for e in r['rule']['expr'] if 'counter' in e) for r in rules if r.get('rule',{}).get('comment')}
if saved.exists():raise RuntimeError('A prior preserved vendor state needs explicit recovery')
def observe():
 return json.loads(subprocess.check_output(['/usr/local/libexec/hoardarr-vpn-status'],timeout=10))
def connect():
 subprocess.run(['nordvpn','connect','Netherlands','Amsterdam'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120)
 for _ in range(30):
  if observe()['connected']:return
  time.sleep(1)
 raise RuntimeError('VPN did not reconnect')
def enable_ipv6():
 for key in ['all','eth0']:Path('/proc/sys/net/ipv6/conf/'+key+'/disable_ipv6').write_text('0')
 run(['ip','-6','address','replace',ipv6_source+'/64','dev','eth0','nodad'])
 mac=json.loads(subprocess.check_output(['ip','-j','link','show','dev','eth0']))[0]['address']
 run(['ip','-6','neigh','replace',ipv6_target,'lladdr',mac,'nud','permanent','dev','eth0'])
def remove_vendor_rules():
 tables=json.loads(subprocess.check_output(['nft','-j','list','tables']))['nftables']
 if any(x.get('table',{}).get('family')=='inet' and x.get('table',{}).get('name')=='nordvpn' for x in tables):run(['nft','delete','table','inet','nordvpn'])
def physical_output_packets(path,exclude_control=False):
 data=path.read_bytes()
 if data[:4]==bytes.fromhex('d4c3b2a1'):endian='<'
 elif data[:4]==bytes.fromhex('a1b2c3d4'):endian='>'
 else:raise RuntimeError('Invalid packet capture header')
 if struct.unpack_from(endian+'I',data,20)[0]!=276:raise RuntimeError('Expected Linux cooked v2 interface metadata')
 offset=24;count=0
 while offset<len(data):
  if offset+16>len(data):raise RuntimeError('Truncated packet record')
  length=struct.unpack_from(endian+'I',data,offset+8)[0];offset+=16
  if length<20 or offset+length>len(data):raise RuntimeError('Truncated cooked packet')
  packet=data[offset:offset+length];offset+=length
  if int.from_bytes(packet[4:8],'big')==2 and packet[10]==4:
   control=packet[:2]==bytes.fromhex('86dd') and len(packet)>=68 and packet[26]==17 and int.from_bytes(packet[62:64],'big')==9997 and packet[68:]==b'root-capture-control'
   if not exclude_control or not control:count+=1
 return count
events=[]
def phase(name,command=None,wait=4):
 (root/'phase').write_text(name)
 begin=time.time()
 if command:subprocess.run(command,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120)
 time.sleep(wait)
 events.append({'phase':name,'started':begin,'finished':time.time(),'observation':observe()})
 (root/'events.json').write_text(json.dumps(events,indent=2))
try:
 if args.with_torlink:
  if not 1<=args.dht_port<=65535:raise RuntimeError('Invalid observed DHT port')
  # Observe packets after every enforcement chain. This table never grants an exception.
  script=f'''table inet hoardarr_qualification {{
chain output {{ type filter hook output priority 300; policy accept;
meta skuid {identity['uid']} oifname != "{identity['vpnInterface']}" oifname != "lo" counter comment "unprotected-uid";
meta skuid {identity['uid']} oifname "{identity['vpnInterface']}" udp sport {args.dht_port} counter comment "torlink-dht-vpn";
meta skuid 0 oifname "eth0" udp dport 9997 counter comment "root-control";
}}
}}'''
  subprocess.run(['nft','-f','-'],input=script.encode(),check=True)
 # Give IPv6 a real egress route and a neighbor so a root packet demonstrably reaches eth0.
 run(['systemctl','stop','nordvpnd.socket','nordvpnd.service'])
 remove_vendor_rules()  # Disposable positive control; the independent UID guard is retained.
 enable_ipv6();route_added=True
 positive=subprocess.Popen(['tcpdump','-Z','root','-U','-n','-i','any','-w',str(root/'positive.pcap'),'ip6','and','dst','host',ipv6_target],stdout=subprocess.DEVNULL,stderr=open(root/'positive-capture.log','w'))
 time.sleep(1)
 s=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,b'eth0\0');s.bind((ipv6_source,0));s.sendto(b'positive-root-control',(ipv6_target,6969));s.close();time.sleep(3)
 positive.send_signal(2);positive.wait(timeout=10)
 positive_count=physical_output_packets(root/'positive.pcap')
 if not positive_count:raise RuntimeError('IPv6 positive packet control failed')
 run(['/usr/local/bin/devvm-local-proxy','start'])
 relay_pid=int(Path('/run/devvm-local-proxy/socat.pid').read_text())
 root_proxy=socket.create_connection((proxy.hostname,proxy.port),timeout=4);root_proxy.close()
 root_relay=socket.create_connection((relay.hostname,relay.port),timeout=4);root_relay.close()
 run(['systemctl','start','nordvpnd.socket','nordvpnd.service']);connect()
 targets={'ipv6Source':ipv6_source,'tcp':[{'host':'1.1.1.1','port':443},{'host':ipv6_target,'port':443},{'host':proxy.hostname,'port':proxy.port},{'host':relay.hostname,'port':relay.port}],
  'udp':[{'host':'1.1.1.1','port':p} for p in [53,6881,6969]]+[{'host':ipv6_target,'port':p} for p in [53,6881,6969]]}
 (root/'targets.json').write_text(json.dumps(targets));(root/'phase').write_text('connected-baseline')
 for p in [root,*root.iterdir()]:os.chown(p,identity['uid'],identity['gid'])
 expression=f'(dst host 1.1.1.1 or dst host {ipv6_target} or (dst host {proxy.hostname} and dst port {proxy.port})) and (tcp or udp)'
 cap=subprocess.Popen(['tcpdump','-Z','root','-U','-n','-i','any','-w',str(root/'direct.pcap'),expression],stdout=subprocess.DEVNULL,stderr=open(root/'capture.log','w'))
 command=['systemd-run','--collect','--unit=hoardarr-extended-probes','-p','User='+identity['user'],'-p','Group='+str(identity['gid']),'-p','NoNewPrivileges=yes','-p','Environment=HTTP_PROXY=http://invalid.invalid:9999 NODE_OPTIONS=--require=/nonexistent-injected-file NODE_USE_ENV_PROXY=1','-p','BindReadOnlyPaths=/etc/hoardarr/resolv.conf:/etc/resolv.conf','/usr/local/libexec/hoardarr-exec','/usr/local/bin/node',str(project/'extended-probe.cjs'),str(root)]
 run(command);probe_started=True
 phase('connected-baseline',wait=12 if args.with_torlink else 4)
 if args.with_torlink and counters()['torlink-dht-vpn']<1:raise RuntimeError('Actual Torlink DHT protected baseline is required')
 phase('manual-disconnect',['nordvpn','disconnect'])
 phase('daemon-SIGTERM',['systemctl','kill','--kill-whom=main','--signal=SIGTERM','nordvpnd.service'],7)
 phase('daemon-SIGKILL',['systemctl','kill','--kill-whom=main','--signal=SIGKILL','nordvpnd.service'],7)
 phase('daemon-stopped',['systemctl','stop','nordvpnd.socket','nordvpnd.service'])
 remove_vendor_rules();enable_ipv6();phase('vendor-rules-unavailable-ipv6-enabled')
 control=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM);control.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,b'eth0\0');control.bind((ipv6_source,0));control.sendto(b'root-capture-control',(ipv6_target,9997));control.close();time.sleep(2)
 # An empty vendor credential store exercises actual unauthenticated startup without revoking the user's account.
 Path('/var/lib/nordvpn').rename(saved);Path('/var/lib/nordvpn').mkdir(mode=0o700)
 phase('unauthenticated-start',['systemctl','start','nordvpnd.socket','nordvpnd.service'],8)
 phase('unauthenticated-connect',['nordvpn','connect','Netherlands','Amsterdam'],3)
 run(['systemctl','stop','nordvpnd.socket','nordvpnd.service'])
 shutil.rmtree('/var/lib/nordvpn');saved.rename('/var/lib/nordvpn')
 phase('restored-vendor-session',['systemctl','start','nordvpnd.socket','nordvpnd.service'],6)
 connect();phase('reconnected')
 phase('interface-down',['ip','link','set',identity['vpnInterface'],'down'])
 connect();phase('interface-reconnected')
 phase('atomic-guard-replacement',['/usr/local/libexec/hoardarr-egress-guard'])
 phase('proxy-unavailable',['kill',str(relay_pid)])
finally:
 if probe_started:subprocess.run(['systemctl','stop','hoardarr-extended-probes'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if cap:cap.send_signal(2);cap.wait(timeout=10)
 if saved.exists():
  subprocess.run(['systemctl','stop','nordvpnd.socket','nordvpnd.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  shutil.rmtree('/var/lib/nordvpn');saved.rename('/var/lib/nordvpn')
 if route_added:
  subprocess.run(['ip','-6','neigh','del',ipv6_target,'dev','eth0'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  subprocess.run(['ip','-6','address','del',ipv6_source+'/64','dev','eth0'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run(['systemctl','start','nordvpnd.socket','nordvpnd.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 connect()
 for key,value in ipv6_settings.items():Path('/proc/sys/net/ipv6/conf/'+key+'/disable_ipv6').write_text(value)
 if args.with_torlink:
  counter_result=counters()
  (root/'uid-counters.json').write_text(json.dumps(counter_result,indent=2))
  run(['nft','delete','table','inet','hoardarr_qualification'])
packets=subprocess.check_output(['tcpdump','-nn','-r',str(root/'direct.pcap')],stderr=subprocess.DEVNULL).decode();(root/'direct-packets.txt').write_text(packets)
probes=[json.loads(line) for line in (root/'probes.jsonl').read_text().splitlines()]
result={'schemaVersion':1,'cases':len(events),'unprotectedPackets':physical_output_packets(root/'direct.pcap',True),'sameCapturePositiveControlPackets':physical_output_packets(root/'direct.pcap')-physical_output_packets(root/'direct.pcap',True),'ipv6PositiveControlPackets':positive_count,
 'proxyPositiveControl':True,'loopbackRelayPositiveControl':True,'allInjectedEnvironmentRemoved':all(p['proxiesAbsent'] for p in probes),
 'baselineTunnelTcpSucceeded':any(p['phase']=='connected-baseline' and any(c['host']=='1.1.1.1' and c['connected'] for c in p['connected']) for p in probes),
 'noProxyOrIpv6TcpConnected':all(not c['connected'] for p in probes for c in p['connected'] if c['host']!='1.1.1.1'),
 'allGuardObservationsValid':all(e['observation']['guardReady'] for e in events),
 'unauthenticatedReadinessRefused':all(not e['observation']['authenticated'] for e in events if e['phase'].startswith('unauthenticated'))}
if args.with_torlink:
 result['actualTorlink']=counter_result
(root/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
assert result['sameCapturePositiveControlPackets']>=1 and result['unprotectedPackets']==0 and result['allGuardObservationsValid'] and result['baselineTunnelTcpSucceeded'] and result['allInjectedEnvironmentRemoved'] and result['noProxyOrIpv6TcpConnected'] and result['unauthenticatedReadinessRefused']
if args.with_torlink:assert counter_result['unprotected-uid']==0 and counter_result['torlink-dht-vpn']>0 and counter_result['root-control']>0
