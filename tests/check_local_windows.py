"""Check a temporary notebook only, via the packaged user's normal CMD entry."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.request import ProxyHandler, build_opener, Request
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'app'))
from platform_config import TZ
from datetime import datetime


def main():
    if sys.platform!='win32':
        raise SystemExit('请在 Windows 上运行这项自检。')
    assert datetime(2026,7,1,tzinfo=TZ).utcoffset().total_seconds()==8*3600
    http=build_opener(ProxyHandler({}))
    actual=0
    with tempfile.TemporaryDirectory(prefix='Lab Note check ') as tmp:
        data=Path(tmp)/'临时空白记录'
        command=['cmd.exe','/d','/c','Start-Lab-Note.cmd','--data-dir',str(data)]
        def run(*args):
            subprocess.run(command+list(args),cwd=ROOT,check=True,timeout=30,stdin=subprocess.DEVNULL)
        try:
            run('--no-open')
            info=json.loads((data/'server.json').read_text(encoding='ascii'))
            actual=info['port']
            run('--no-open')
            assert info==json.loads((data/'server.json').read_text(encoding='ascii'))
            base=f'http://127.0.0.1:{actual}'
            with http.open(base+'/api/state',timeout=8) as res:
                boot=json.load(res)
            assert Path(boot['data_dir'])==data.resolve() and not boot['state']['containers'] and not boot['state'].get('lab_records',[])
            assert not boot['state'].get('frozen_batches') and not boot['state'].get('cryo_storage', {}).get('devices')
            installed = (ROOT/'VERSION').read_text(encoding='ascii').strip()
            with http.open(base+'/api/version',timeout=8) as response:
                assert json.load(response)['version']==installed==boot['app_version']
            assert installed=='1.5.1-preview.1', installed
            cli=subprocess.check_output(command+['--version'],cwd=ROOT,encoding='utf-8')
            assert installed in cli, cli
            with http.open(base+'/api/storage-stats',timeout=8) as response:
                assert json.load(response)['total_events']==0
            for route in ('/cryo-storage.js', '/cryo-storage.css','/theme.js','/theme-dark.css','/cryo-print.js'):
                with http.open(base+route,timeout=8) as asset:
                    assert asset.status==200 and asset.read(32)
            # Exercise new commands on the isolated database through the embedded Python runtime.
            command_data=json.dumps({'action':'cryo_device_save','revision':boot['state']['revision'],
                                     'client_request_id':'windows-check-inventory',
                                     'payload':{'name':'Test storage','kind':'custom'}}).encode()
            for attempt in range(2):
                req=Request(base+'/api/command',data=command_data,headers={'Content-Type':'application/json','X-Lab-Token':boot['token']})
                with http.open(req,timeout=10) as res: updated=json.load(res)['state']
                assert len(updated['cryo_storage']['devices'])==1 and updated['revision']==boot['state']['revision']+1
            # Confirm free-text fields survive a real save with the bundled Windows runtime.
            lot_data={'name':'Inventory check','at':'2020-01-01','vials':1,'storage_stage':'unassigned',
                      'cell_kind':'Custom category','resistance_tags':['Test tag']}
            req=Request(base+'/api/command',data=json.dumps({'action':'cryo_stock_create','revision':updated['revision'],
                        'payload':lot_data}).encode(),headers={'Content-Type':'application/json','X-Lab-Token':boot['token']})
            with http.open(req,timeout=10) as res: lot=json.load(res)['state']['frozen_batches'][0]
            assert lot['cell_kind']==lot_data['cell_kind'] and lot['resistance_tags']==lot_data['resistance_tags']
            req=Request(base+'/api/backup',data=b'{}',headers={'Content-Type':'application/json','X-Lab-Token':boot['token']})
            with http.open(req,timeout=10) as res:backup=json.load(res)
            with http.open(base+backup['url'],timeout=10) as res, ZipFile(io.BytesIO(res.read())) as z:
                assert hashlib.sha256(z.read('culture.sqlite3')).hexdigest()==z.read('original-file.sha256').decode().split()[0]
        finally:
            if (data/'server.json').exists():run('--stop')
    print(f'自检通过：北京时间、临时库启动、端口 {actual}、重复启动、空白记录、备份校验和停止服务。')


if __name__=='__main__':
    main()
