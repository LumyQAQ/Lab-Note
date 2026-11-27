"""Build only an offline Windows x64 archive using the reviewed app file list."""
import argparse
import hashlib
from io import BytesIO
from pathlib import Path, PurePosixPath
import runpy
import zipfile

ROOT=Path(__file__).resolve().parents[1]
RUNTIME_SHA256='90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159'
NAME='Lab-Note-1.5.0-preview.1-Windows-x64.zip'


def build(runtime_path,out):
    data=runtime_path.read_bytes()
    if hashlib.sha256(data).hexdigest()!=RUNTIME_SHA256:
        raise ValueError('官方 Python 3.14.10 x64 嵌入包 SHA-256 不匹配')
    app_files=[f for f in runpy.run_path(str(ROOT/'scripts/build_release.py'))['FILES'] if f.startswith('app/') and f != 'app/mac_update.py']
    extra=['Start-Lab-Note.cmd','Stop-Lab-Note.cmd','Check-Lab-Note.cmd','tests/check_local_windows.py']
    license_text='''Lab Note · Windows x64 本地预览版
软件作者：LumyQAQ，https://github.com/LumyQAQ

runtime/ 包含 Python Software Foundation 官方 CPython 3.14.10 64 位嵌入式发行包。其文件按原字节分发，版权和第三方许可全文保留在 runtime/LICENSE.txt。
上游下载：https://www.python.org/ftp/python/3.14.10/python-3.14.10-embed-amd64.zip
官方发行页：https://www.python.org/downloads/release/python-31410/
上游 ZIP SHA-256：'''+RUNTIME_SHA256+'''

app/tzdata/Shanghai.tzif 是 IANA TZDB 中的 Asia/Shanghai 区域数据（版本 2026f），用于系统缺少 IANA 时区库时的北京时间换算。来源：https://www.iana.org/time-zones
'''
    out.mkdir(parents=True,exist_ok=True)
    target=out/NAME;pending=target.with_suffix('.tmp')
    with zipfile.ZipFile(BytesIO(data)) as upstream,zipfile.ZipFile(pending,'w') as archive:
        if upstream.testzip():raise ValueError('Python 归档完整性校验失败')
        def put(path,content):
            path=PurePosixPath(path)
            if path.is_absolute() or '..' in path.parts:raise ValueError(path)
            info=zipfile.ZipInfo('Lab-Note/'+path.as_posix(),(2026,1,1,0,0,0))
            info.create_system=3;info.external_attr=0o100644<<16
            archive.writestr(info,content,compress_type=zipfile.ZIP_DEFLATED)
        put('VERSION', b'1.5.0-preview.1\n')
        for f in app_files+extra:put(f,(ROOT/f).read_bytes())
        put('使用说明.txt',(ROOT/'packaging/windows-readme.txt').read_text(encoding='utf-8').replace('\n','\r\n').encode('utf-8-sig'))
        put('第三方许可说明.txt',license_text.encode('utf-8-sig'))
        for entry in upstream.infolist():
            if not entry.is_dir():put('runtime/'+entry.filename,upstream.read(entry))
    pending.replace(target)
    print(target,target.stat().st_size,hashlib.sha256(target.read_bytes()).hexdigest())


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('runtime',type=Path)
    parser.add_argument('out',type=Path)
    args=parser.parse_args()
    build(args.runtime,args.out)
