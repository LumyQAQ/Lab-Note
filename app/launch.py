#!/usr/bin/env python3
"""Start once and open the local notebook; bypass system proxies for health checks."""
import argparse
import json
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.request import build_opener, ProxyHandler

from server import DEFAULT_DATA

ROOT = Path(__file__).resolve().parent

URL = 'http://127.0.0.1:8875'


def health():
    try:
        with build_opener(ProxyHandler({})).open(URL+'/api/state', timeout=1) as response:
            payload = json.load(response)
        return payload.get('app') == 'lab-culture-v1' and Path(payload.get('data_dir','')).resolve() == DEFAULT_DATA
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    if not health():
        data = DEFAULT_DATA
        data.mkdir(parents=True,mode=0o700,exist_ok=True)
        with (data/'server.log').open('a') as log:
            process = subprocess.Popen([sys.executable, str(ROOT/'server.py')], cwd=ROOT,
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                       start_new_session=True)
        for _ in range(40):
            if health():
                (data/'server.pid').write_text(str(process.pid))
                break
            if process.poll() is not None:
                raise SystemExit(f'启动失败，请查看 {data / "server.log"}；8875 端口可能被其他程序占用。')
            time.sleep(.2)
        else:
            raise SystemExit(f'启动超时，请查看 {data / "server.log"}')
    if not args.no_open:
        webbrowser.open(URL)
    print(f'培养工作台已启动：{URL}')
    print('关闭浏览器不会停止后台保存。电脑重新启动后，请再次双击启动文件。')


if __name__ == '__main__':
    main()
