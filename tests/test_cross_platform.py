"""Exercise the normal launchers and an isolated database, including Windows paths."""
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch
from urllib.request import ProxyHandler, Request, build_opener
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
import platform_config


class CrossPlatformTests(unittest.TestCase):
    def test_data_locations_and_timezone_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict(os.environ, {'LOCALAPPDATA': folder}), patch.object(sys, 'platform', 'win32'):
                self.assertEqual(platform_config.default_data_dir(), Path(folder) / 'Lab Note')
            with patch.object(sys, 'platform', 'darwin'):
                self.assertEqual(platform_config.default_data_dir(), Path.home()/'Library/Application Support/Culture Notes Share')
        from zoneinfo import ZoneInfoNotFoundError
        with patch.object(platform_config, 'ZoneInfo', side_effect=ZoneInfoNotFoundError) as loader:
            from zoneinfo import ZoneInfo
            loader.from_file.side_effect=ZoneInfo.from_file
            tz=platform_config.beijing_timezone()
        self.assertEqual(datetime(2026,7,1,tzinfo=tz).utcoffset(),timedelta(hours=8))
        self.assertEqual(datetime(1991,7,1,tzinfo=tz).utcoffset(),timedelta(hours=9))

    def test_unused_notebook_remains_blank_after_nightly_check(self):
        from store import Store
        with tempfile.TemporaryDirectory() as tmp:
            store=Store(tmp)
            self.assertIsNone(store.daily(datetime(2026,11,20,22,1,tzinfo=platform_config.TZ)))
            self.assertEqual(store.snapshots(),[])

    def test_double_click_entry_reuses_service_and_can_save_and_back_up(self):
        with tempfile.TemporaryDirectory() as folder:
            data=Path(folder)/'本机记录 with spaces'
            with socket.socket() as s:
                s.bind(('127.0.0.1',0));port=s.getsockname()[1]
            base=f'http://127.0.0.1:{port}'
            http=build_opener(ProxyHandler({}))
            def get(route):
                with http.open(base+route,timeout=8) as response:return response.read()
            def post(route,body,token):
                req=Request(base+route,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','X-Lab-Token':token})
                with http.open(req,timeout=8) as response:return json.load(response)
            if os.name=='nt':
                entry=['cmd.exe','/d','/c','Start-Lab-Note.cmd']
            else:
                entry=['/bin/zsh',str(ROOT/'启动实验日记.command')]
            args=entry+['--no-open','--data-dir',str(data),'--port',str(port)]
            pidfile=data/'server.pid'
            try:
                subprocess.run(args,cwd=ROOT,check=True,stdin=subprocess.DEVNULL,timeout=35)
                b=json.loads(get('/api/state'));self.assertEqual(Path(b['data_dir']),data.resolve())
                self.assertEqual(b['state']['containers'],[]);self.assertEqual(b['state'].get('lab_records',[]),[])
                pid=pidfile.read_text()
                subprocess.run(args,cwd=ROOT,check=True,stdin=subprocess.DEVNULL,timeout=20)
                self.assertEqual(pid,pidfile.read_text())
                cmd=post('/api/command',{'action':'create','payload':{'name':'临时核验','type':'6孔板'},'revision':b['state']['revision']},b['token'])
                self.assertEqual(cmd['state']['containers'][0]['name'],'临时核验')
                backup=post('/api/backup',{},b['token'])
                with ZipFile(io.BytesIO(get(backup['url']))) as z:
                    digest=hashlib.sha256(z.read('culture.sqlite3')).hexdigest()
                    self.assertTrue(z.read('original-file.sha256').decode().startswith(digest))
                self.assertEqual(json.loads(get('/api/state'))['state']['revision'],cmd['state']['revision'])
            finally:
                if pidfile.exists():
                    subprocess.run([*entry,'--stop','--data-dir',str(data)],cwd=ROOT,check=True,stdin=subprocess.DEVNULL,timeout=20)
                    for _ in range(60):
                        with socket.socket() as s:
                            if s.connect_ex(('127.0.0.1',port))!=0:break
                        time.sleep(.05)

    def test_busy_preferred_port_auto_reuse_and_explicit_error(self):
        with tempfile.TemporaryDirectory() as tmp, socket.socket() as taken:
            taken.bind(('127.0.0.1',0));taken.listen()
            # Exercise strict-port failure without depending on other services on the machine.
            port=taken.getsockname()[1]
            command=[sys.executable,'-X','utf8',str(ROOT/'app'/'launch.py'),'--no-open','--data-dir',tmp]
            bad=subprocess.run(command+['--port',str(port)],capture_output=True,encoding='utf-8',timeout=20)
            self.assertNotEqual(bad.returncode,0)
            self.assertIn(str(port),bad.stderr);self.assertIn('--port auto',bad.stderr)
        with tempfile.TemporaryDirectory() as tmp,socket.socket() as blocker:
            try:
                blocker.bind(('127.0.0.1',8875));blocker.listen()
            except OSError:
                pass  # An existing local service also exercises the fallback.
            command=[sys.executable,'-X','utf8',str(ROOT/'app'/'launch.py'),'--data-dir',tmp]
            try:
                first=subprocess.run(command+['--no-open'],check=True,capture_output=True,encoding='utf-8',timeout=25)
                meta=json.loads((Path(tmp)/'server.json').read_text())
                self.assertNotEqual(meta['port'],8875)
                self.assertIn(':'+str(meta['port']),first.stdout)
                subprocess.run(command+['--no-open'],check=True,capture_output=True,timeout=15)
                self.assertEqual(meta,json.loads((Path(tmp)/'server.json').read_text()))
                status=subprocess.check_output(command+['--status'],encoding='utf-8')
                self.assertIn(':'+str(meta['port']),status)
            finally:
                subprocess.run(command+['--stop'],check=True,capture_output=True,timeout=15)
