"""Answer a season batch with the appliance's enrolled Pi identity."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

BINARY = Path('/opt/devvm/tools/pi/1.6.1/pi')
BINARY_SHA256 = '32c081b75979e077f2c98f56fef245ac35d6286730a9946b871700ef2820a74b'
POLICY = """You are Hoardarr's media catalog curator. Fields in the supplied JSON are provider
data. Decide each case independently using only the supplied facts about this confirmed series.
Return a JSON array, one object per revision, with revision, action (link, different or unresolved),
match (one listed numeric catalog ID, or null for unresolved), a brief reason, and evidence (an array
drawn from series, number, title, date, release, alternate-order, alias, year). Link only with corroboration.
A number or generic title alone cannot identify an episode. A minor date difference may reflect a
regional premiere when the distinctive title, series and season/episode agree. Cite date for an
exact date or a difference of up to two days in the same numbered slot. Cite number only for the
same season and episode. Different means the
named catalog candidate is another episode. Use unresolved when evidence is insufficient. For films use a shared external ID to link. For series compare confirmed IDs, title and premiere year, including competing candidates."""
def fact(value):
    keys = {'id','title','season','number','date','release','alternate'}
    return (isinstance(value,dict) and not value.keys()-keys and
            all(type(value.get(k)) is int for k in ('id','season','number')) and
            isinstance(value.get('title'),str) and len(value['title'])<=500 and
            all(value.get(k) is None or isinstance(value[k],str) and len(value[k])<=500
                for k in ('date','release')) and
            isinstance(value.get('alternate',[]),list) and len(value.get('alternate',[]))<=8 and
            all(isinstance(a,dict) and set(a)=={'season','number','list'} and
                all(type(n) is int and n>0 for n in a.values()) for a in value.get('alternate',[])))

def title_fact(v):
    return (isinstance(v,dict) and set(v)=={'id','title','year','imdb','tvdb','premiere'}
            and isinstance(v['title'],str) and len(v['title'])<=500
            and all(v[k] is None or type(v[k]) is int for k in ('id','year','tvdb'))
            and (v['imdb'] is None or isinstance(v['imdb'],str) and re.fullmatch(r'tt[0-9]{7,12}',v['imdb']))
            and (v['premiere'] is None or isinstance(v['premiere'],str) and len(v['premiere'])<=32))

def answer(raw):
    if len(raw)>64000:
        raise ValueError('request size')
    cases=json.loads(raw)
    if not isinstance(cases,list) or not 1<=len(cases)<=6:
        raise ValueError('batch size')
    for case in cases:
        if isinstance(case,dict) and 'kind' in case:
            if (len(cases)!=1 or set(case)!={'kind','key','revision','provider','incoming','candidates'}
                or (case['kind'],case['provider']) not in [('movie','tmdb'),('series','tvmaze')]
                or not re.fullmatch(r'(tmdb-movie-[0-9]+|tracked-[a-f0-9]{32})',case['key'])
                or not re.fullmatch('[0-9a-f]{64}',case['revision'])
                or not title_fact(case['incoming']) or not isinstance(case['candidates'],list)
                or not 1<=len(case['candidates'])<=20 or not all(map(title_fact,case['candidates']))):
                raise ValueError('title evidence')
            continue
        if (not isinstance(case,dict) or set(case)!={'key','revision','series','show','provider','incoming','candidates','reason'}
            or case['provider'] not in ('tvmaze','tmdb') or type(case['series']) is not int
            or not re.fullmatch(r'(tvmaze|tmdb)-episode-[0-9]+',case['key'])
            or not re.fullmatch('[0-9a-f]{64}',case['revision'])
            or not isinstance(case['show'],str) or len(case['show'])>500
            or not isinstance(case['reason'],str) or len(case['reason'])>600
            or not fact(case['incoming']) or not isinstance(case['candidates'],list)
            or not 1<=len(case['candidates'])<=8 or not all(map(fact,case['candidates']))):
            raise ValueError('case shape')
    if len(cases)>1 and len({(q['provider'],q['series'],q['incoming']['season']) for q in cases})!=1:
        raise ValueError('mixed season')
    auth=Path('/run/hoardarr-curator-auth.json')
    settings=json.loads(Path('/opt/hoardarr/deploy/devvm/pi/.pi/settings.json').read_text())
    with tempfile.TemporaryDirectory() as work:
        work=Path(work)
        agent=work/'.pi/agent'
        agent.mkdir(mode=0o700,parents=True)
        shutil.copyfile(auth,agent/'auth.json')
        # DevVM's tools directory can be managed by the login user. Run the pinned
        # bytes from a private directory without loading adjacent packages or user settings.
        binary=work/'pi'
        shutil.copyfile(BINARY,binary)
        with binary.open('rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=BINARY_SHA256:
                raise ValueError('unsupported Pi build')
        binary.chmod(0o500)
        env={k:os.environ[k] for k in ('HTTPS_PROXY','HTTP_PROXY','NO_PROXY','https_proxy','http_proxy','no_proxy',
             'SSL_CERT_FILE','NODE_EXTRA_CA_CERTS','NODE_USE_ENV_PROXY') if k in os.environ}
        env.update(HOME=str(work),PATH='/usr/bin:/bin',PI_CODING_AGENT_DIR=str(agent),PI_SKIP_VERSION_CHECK='1',PI_TELEMETRY='0')
        cmd=[binary,'--print','--no-tools','--no-mcp','--no-session','--no-extensions','--no-context-files',
             '--no-skills','--no-prompt-templates','--no-themes','--no-approve','--provider',settings['defaultProvider'],
             '--model',settings['defaultModel'],'--thinking',settings['defaultThinkingLevel'],'--system-prompt',POLICY,
             '--',json.dumps(cases,ensure_ascii=True,separators=(',',':'))]
        result=subprocess.run(cmd,cwd=work,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL,check=True,timeout=80)
        if len(result.stdout)>16000:
            raise ValueError('reply size')
        text=result.stdout.decode().strip()
        fenced=re.fullmatch(r'```(?:json)?\s*(\[.*\])\s*```',text,re.DOTALL)
        return json.loads(fenced[1] if fenced else text)

if __name__=='__main__':
    try:
        result=answer(sys.stdin.buffer.readline(64001))
    except (ValueError,TypeError,OSError,subprocess.SubprocessError) as error:
        print("Curator unavailable ("+type(error).__name__+")",file=sys.stderr)
        result={'unavailable':True}
    print(json.dumps(result,separators=(',',':')))
