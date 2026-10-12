#!/usr/bin/env python3
"""Offline allowlisted codec context materialization. No installation/Docker/download."""
from pathlib import Path,PurePosixPath
import argparse,json,hashlib,base64,tarfile,os,stat
os.umask(0o077)
R=Path(__file__).resolve().parent
def require(ok):
 if not ok:raise ValueError('codec_build_input_invalid')
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def check(p,row):
 require(not p.is_symlink() and stat.S_ISREG(p.lstat().st_mode) and p.stat().st_size==row['bytes'] and digest(p)==row['sha256'])
def write(p,b):
 p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 with p.open('xb') as f:f.write(b)
def pins():
 m=json.loads((R/'build-inputs.json').read_text());require(m['manifestVersion']==1 and len(m['files'])==150)
 require(len({r['path'] for r in m['files']})==150)
 for row in m['files']:
  p=PurePosixPath(row['path']);require(not p.is_absolute() and '..' not in p.parts and '\\' not in row['path'])
 return m
def verify(context,m):
 actual={p.relative_to(context).as_posix() for p in context.rglob('*') if p.is_file()}
 require(actual=={r['path'] for r in m['files']})
 for row in m['files']:check(context/row['path'],row)
def materialize(m,repo,artifacts,source_verification,npm,out):
 require(out.parent==Path('/private/tmp') and out.name.startswith('wm-gallery-codec-context-') and not out.exists())
 # Preflight all allowlisted inputs before output creation.
 by={r['path']:r for r in m['files']}
 for target,rel in m['sourceMap'].items():check(repo/rel,by[target])
 for target in by:
  if target.startswith('artifacts/'):check(artifacts/PurePosixPath(target).name,by[target])
 check(source_verification,by['licenses/source-verification.json'])
 check(R/'Dockerfile',by['Dockerfile']);check(R/'unpack-tools.py',by['build-tools/unpack-tools.py'])
 packages=json.loads((R/'npm-pins.json').read_text());require(len(packages)==6)
 pkg_bytes=[]
 for i,p in enumerate(packages):
  cache=npm/(str(i)+'.tgz');require(not cache.is_symlink() and cache.is_file());b=cache.read_bytes();require(0<len(b)<=67108864)
  require('sha512-'+base64.b64encode(hashlib.sha512(b).digest()).decode()==p['integrity']);pkg_bytes.append(len(b))
 require(sum(pkg_bytes)<=134217728)
 out.mkdir(mode=0o700);records=[]
 for target,rel in m['sourceMap'].items():write(out/target,(repo/rel).read_bytes())
 for target in by:
  if target.startswith('artifacts/'):write(out/target,(artifacts/PurePosixPath(target).name).read_bytes())
 write(out/'licenses/source-verification.json',source_verification.read_bytes())
 write(out/'Dockerfile',(R/'Dockerfile').read_bytes());write(out/'build-tools/unpack-tools.py',(R/'unpack-tools.py').read_bytes())
 for target,text in m['inline'].items():write(out/target,text.encode())
 for i,p in enumerate(packages):
  archive=npm/(str(i)+'.tgz');dest=out/'codec/node_modules'/p['name'];dest.mkdir(mode=0o700,parents=True)
  with tarfile.open(archive,'r:gz') as tar:
   members=tar.getmembers();require(len(members)<=20000 and len({x.name for x in members})==len(members));require(sum(x.size for x in members)<=268435456)
   for x in members:
    rel=PurePosixPath(x.name);require(rel.parts and rel.parts[0]=='package' and not rel.is_absolute() and '..' not in rel.parts and '\\' not in x.name and (x.isdir() or x.isfile()))
   for x in members:
    parts=PurePosixPath(x.name).parts[1:]
    if not parts:continue
    target=dest.joinpath(*parts)
    if x.isdir():target.mkdir(parents=True,exist_ok=True,mode=0o700);continue
    with tar.extractfile(x) as f:b=f.read(x.size+1)
    require(len(b)==x.size);write(target,b);target.chmod(0o755 if x.mode&0o111 else 0o644)
  package=json.loads((dest/'package.json').read_text());require(package['name']==p['name'] and package['version']==p['version'])
  if p['name']=='sharp':
   require(package.get('dependencies')=={'@img/colour':'^1.1.0','detect-libc':'^2.1.2','semver':'^7.8.5'})
   require(package['optionalDependencies']['@img/sharp-linux-arm64']=='0.35.4' and package['optionalDependencies']['@img/sharp-libvips-linux-arm64']=='1.3.3')
  else:require(not package.get('dependencies'))
  records.append({**p,'byteSize':pkg_bytes[i],'sha256':digest(archive)})
 write(out/'licenses/npm-artifacts.json',(json.dumps(records,indent=2)+'\n').encode())
 files=sorted(p for p in out.rglob('*') if p.is_file())
 write(out/'context-checksums.sha256',''.join(digest(p)+'  '+p.relative_to(out).as_posix()+'\n' for p in files).encode())
 verify(out,m)
 return len(files)+1
if __name__=='__main__':
 a=argparse.ArgumentParser();sub=a.add_subparsers(dest='mode',required=True)
 v=sub.add_parser('verify-reference');v.add_argument('context',type=Path)
 n=sub.add_parser('materialize');n.add_argument('--repo',type=Path,required=True);n.add_argument('--artifacts',type=Path,required=True);n.add_argument('--source-verification',type=Path,required=True);n.add_argument('--npm-cache',type=Path,required=True);n.add_argument('--output',type=Path,required=True)
 args=a.parse_args()
 try:
  m=pins()
  if args.mode=='verify-reference':verify(args.context,m);print(json.dumps({'verifiedFiles':150,'dockerExecuted':False}))
  else:print(json.dumps({'materializedFiles':materialize(m,args.repo,args.artifacts,args.source_verification,args.npm_cache,args.output),'dockerExecuted':False}))
 except Exception:print(json.dumps({'accepted':False,'reason':'codec_build_input_invalid','dockerExecuted':False}));raise SystemExit(1)
