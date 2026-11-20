#!/usr/bin/env python3
"""Start, locate or stop the user's own loopback notebook."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import build_opener, ProxyHandler, Request
import webbrowser

ROOT=Path(__file__).resolve().parent
# The official Windows embeddable distribution intentionally omits the script directory.
if str(ROOT) not in sys.path:
    sys.path.insert(0,str(ROOT))
from platform_config import default_data_dir, port_value
HTTP=build_opener(ProxyHandler({}))


def endpoint(port):
    return f'http://127.0.0.1:{port}'


def running_server(port,data):
    url=endpoint(port)
    try:
        try:
            response=HTTP.open(url+'/api/health',timeout=.8)
        except HTTPError as error:
            if error.code!=404 or port!=8875 or data!=default_data_dir().resolve():raise
            error.close()
            response=HTTP.open(url+'/api/state',timeout=2)  # Recognize an existing v1.0 service.
        with response:info=json.load(response)
        if info.get('app')=='lab-culture-v1' and info.get('data_dir') and Path(info['data_dir']).resolve()==data:
            return info
    except (OSError,ValueError,TypeError,AttributeError):
        pass
    return None


def existing(data,requested):
    try:
        last=json.loads((data/'server.json').read_text(encoding='ascii'))['port']
    except (OSError,ValueError,KeyError,TypeError):
        last=None
    for port in dict.fromkeys((last,requested,8875)):
        if type(port) is int and 1<=port<=65535:
            info=running_server(port,data)
            if info is not None:return port,info
    return None,None


@contextmanager
def launch_lock(data):
    # Serialize double-clicks, including when an automatic port hasn't been published yet.
    with (data/'launcher.lock').open('a+b') as lock:
        if os.name=='nt':
            import msvcrt
            if lock.tell()==0:lock.write(b'0');lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(),msvcrt.LK_LOCK,1)
        else:
            import fcntl
            fcntl.flock(lock,fcntl.LOCK_EX)
        try:yield
        finally:
            if os.name=='nt':
                lock.seek(0)
                msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1)
            else:
                fcntl.flock(lock,fcntl.LOCK_UN)


def start(data,port):
    options={'creationflags':subprocess.CREATE_NO_WINDOW} if os.name=='nt' else {'start_new_session':True}
    log_path=data/'server.log'
    with tempfile.TemporaryDirectory(prefix='.starting-',dir=data) as tmp:
        ready=Path(tmp)/'ready.json'
        args=[sys.executable,'-X','utf8','-B',str(ROOT/'server.py'),'--data-dir',str(data),
              '--port',str(port) if port else 'auto','--ready-file',str(ready)]
        with log_path.open('ab') as log:
            offset=log.tell()
            child=subprocess.Popen(args,cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=log,**options)
        try:
            until=time.monotonic()+15
            while time.monotonic()<until:
                if ready.is_file():
                    bound=json.loads(ready.read_text(encoding='ascii'))['port']
                    info=running_server(bound,data)
                    if info and info.get('pid')==child.pid:
                        (data/'server.pid').write_text(str(child.pid),encoding='ascii')
                        metadata=data/'server.json.tmp'
                        metadata.write_text(json.dumps({'pid':child.pid,'port':bound}),encoding='ascii')
                        metadata.replace(data/'server.json')
                        return bound
                code=child.poll()
                if code is not None:
                    if code==98:
                        raise SystemExit(f'端口 {port or 8875} 无法绑定（已占用或被系统保留）。可用 --port auto 或 --port 8890。\n日志：{log_path}')
                    with log_path.open('rb') as log:
                        log.seek(max(offset,log_path.stat().st_size-2048))
                        lines=log.read().decode('utf-8','replace').strip().splitlines()
                    reason=lines[-1] if lines else f'后台进程退出，代码 {code}'
                    raise SystemExit(f'启动失败：{reason}\n详细日志：{log_path}')
                time.sleep(.12)
            raise SystemExit(f'工作台在 15 秒内未就绪。请查看本次启动日志：{log_path}')
        except BaseException:
            if child.poll() is None:
                child.terminate();child.wait(timeout=5)
            raise


def stop(port,info,data):
    if not info.get('pid'):
        raise SystemExit('此服务来自较早的版本，请先关闭旧服务。')
    url=endpoint(port)
    with HTTP.open(url+'/api/state',timeout=10) as response:state=json.load(response)
    if Path(state['data_dir']).resolve()!=data:raise SystemExit('数据目录已变化，请重新检查状态。')
    request=Request(url+'/api/stop',data=b'{}',headers={'Content-Type':'application/json','X-Lab-Token':state['token']})
    with HTTP.open(request,timeout=5) as response:json.load(response)
    for _ in range(70):
        current=running_server(port,data)
        if not current or current.get('pid')!=info['pid']:break
        time.sleep(.1)
    else:raise SystemExit('已请求停止，但服务仍在运行。')
    print('本机工作台已停止。')


def main():
    parser=argparse.ArgumentParser(prog='launch.py',allow_abbrev=False,add_help=False,
        description='启动、查询或停止 Lab Note 本机工作台。默认打开浏览器，数据只保存在当前电脑。',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=r'''Windows 本地版示例（在解压目录的 PowerShell 中执行）：
  .\Start-Lab-Note.cmd                         自动启动并打开浏览器
  .\Start-Lab-Note.cmd --port 8890             指定端口
  .\Start-Lab-Note.cmd --no-open --port auto   仅启动，打印实际网址
  .\Start-Lab-Note.cmd --status                查看正在使用的端口、数据目录和日志
  .\Start-Lab-Note.cmd --data-dir "D:\Lab Notes" --port 8890
  .\Stop-Lab-Note.cmd                          关闭后台服务

使用系统 Python 时，也可以运行 python .\app\launch.py --port 8890。
更改已运行服务的端口：先用同一数据目录执行 --stop，然后用新端口启动。''')
    parser.add_argument('--version',action='version',version='Lab Note 1.1.0-preview.1 (local)',help='显示本地程序版本')
    parser.add_argument('-h','--help',action='help',help='显示本页说明和示例后退出')
    parser.add_argument('--port',type=port_value,default='auto',metavar='auto|PORT',
                        help='默认 auto：优先 8875，冲突时由系统分配空闲端口；指定 1–65535 时严格使用该端口')
    parser.add_argument('--data-dir',type=Path,default=default_data_dir(),metavar='PATH',
                        help='指定数据库、日志与备份的目录；Windows 默认使用当前用户的 LocalAppData 下的 Lab Note')
    parser.add_argument('--no-open',action='store_true',help='启动后只打印本机网址，不自动打开浏览器')
    group=parser.add_mutually_exclusive_group()
    group.add_argument('--status',action='store_true',help='显示该数据目录的服务状态、网址和日志位置')
    group.add_argument('--stop',action='store_true',help='停止该数据目录已运行的服务，保留记录')
    args=parser.parse_args()
    data=args.data_dir.expanduser().resolve()
    if args.status:
        port,_=existing(data,args.port)
        print(('运行中：'+endpoint(port) if port else '当前未运行')+f'\n数据目录：{data}\n日志：{data / "server.log"}')
        return
    if args.stop and not data.exists():
        print('此数据目录没有运行中的工作台。');return
    data.mkdir(parents=True,mode=0o700,exist_ok=True)
    with launch_lock(data):
        port,info=existing(data,args.port)
        if args.stop:
            if port:stop(port,info,data)
            else:print('此数据目录没有运行中的工作台。')
            return
        if port and args.port and port!=args.port:
            raise SystemExit(f'此数据目录已在 {endpoint(port)} 运行。要改用 {args.port}，请先执行 --stop。')
        if not port:port=start(data,args.port)
    url=endpoint(port)
    if not args.no_open:webbrowser.open(url)
    print(f'Lab Note 已启动：{url}\n数据目录：{data}\n日志：{data / "server.log"}')


if __name__=='__main__':
    try:
        main()
    except OSError as error:
        raise SystemExit(f'本机启动操作失败：{error}') from None
