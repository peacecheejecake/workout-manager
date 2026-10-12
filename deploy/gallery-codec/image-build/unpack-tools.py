import os, pathlib, stat, sys, zipfile, tarfile
assert sys.version_info >= (3,7)
for name,target,limit in [('meson-1.9.2-py3-none-any.whl','/build/meson',16000000),('ninja-linux-aarch64.zip','/build/ninja',2000000)]:
    total=0
    with zipfile.ZipFile('/input/artifacts/'+name) as z:
        entries=z.infolist(); assert 0<len(entries)<=2000
        assert len({i.filename for i in entries})==len(entries)
        if name.startswith('ninja'): assert [i.filename for i in entries]==['ninja']
        for i in entries:
            rel=pathlib.PurePosixPath(i.filename)
            assert not rel.is_absolute() and all(p not in ('..','.') for p in rel.parts)
            assert '\\' not in i.filename and '\x00' not in i.filename
            assert not stat.S_ISLNK(i.external_attr >> 16)
            total+=i.file_size; assert total<=limit
        z.extractall(target)
        if name.startswith('meson'):
            metadata=pathlib.Path(target+'/meson-1.9.2.dist-info/METADATA').read_text()
            assert '\nVersion: 1.9.2\n' in metadata
            assert '\nRequires-Python: >=3.7\n' in metadata
os.chmod('/build/ninja/ninja',0o755)
def inspect_tar(name, prefix, count_limit, byte_limit):
    archive=tarfile.open('/input/artifacts/'+name)
    members=archive.getmembers()
    assert 0<len(members)<=count_limit
    assert len({m.name for m in members})==len(members)
    assert sum(m.size for m in members)<=byte_limit
    for m in members:
        rel=pathlib.PurePosixPath(m.name)
        assert not rel.is_absolute() and rel.parts[0]==prefix
        assert all(p not in ('..','.') for p in rel.parts)
        assert '\\' not in m.name and '\x00' not in m.name
        assert m.isdir() or m.isfile()
    return archive,members
with inspect_tar('dav1d-1.5.4.tar.xz','dav1d-1.5.4',500,16000000)[0] as archive:
    for m in archive.getmembers():
        rel=pathlib.PurePosixPath(m.name).parts[1:]
        dest=pathlib.Path('/build/dav1d').joinpath(*rel)
        if m.isdir(): dest.mkdir(parents=True,exist_ok=True)
        else:
            dest.parent.mkdir(parents=True,exist_ok=True)
            with archive.extractfile(m) as source, dest.open('xb') as output:
                payload=source.read(m.size+1); assert len(payload)==m.size
                output.write(payload)
with inspect_tar('meson-1.9.2.tar.gz','meson-1.9.2',7000,16000000)[0] as archive:
    with archive.extractfile('meson-1.9.2/COPYING') as source:
        payload=source.read(65537); assert len(payload)<=65536
        pathlib.Path('/opt/codec/meson-COPYING').write_bytes(payload)
