"""Verify a clean installation using a private temporary directory."""
import json
from pathlib import Path
import re
import sys
import tempfile
import threading
import unittest
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'app'))
from server import make_server


class PublicNotebookTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        server=make_server(folder.name,0)
        self.assertEqual(server.server_address[0],"127.0.0.1")
        self.addCleanup(server.server_close)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.shutdown)
        self.url=f'http://127.0.0.1:{server.server_port}'
        self.http=build_opener(ProxyHandler({}))
        self.boot=self.get('/api/state')
        self.state=self.boot['state']

    def get(self,path):
        with self.http.open(self.url+path) as response:
            return json.load(response) if response.headers.get_content_type()=='application/json' else response.read()

    def test_assets_and_blank_installation(self):
        self.assertEqual(self.state['containers'],[])
        self.assertEqual(self.state.get('lab_records',[]),[])
        page=self.get('/').decode()
        for asset in re.findall(r'(?:src|href)="(/[^"?#]+\.(?:js|css|png|webmanifest)(?:\?v=[a-f0-9]+)?)"',page):
            with self.subTest(asset=asset):self.assertTrue(self.get(asset))

    def test_no_prior_history(self):
        self.assertEqual(self.state['revision'],0)
        self.assertEqual(self.get('/api/events'),[])
        self.assertEqual(self.get('/api/snapshots'),[])
        self.assertFalse(self.boot['last_backup'])

    def test_local_only(self):
        for path in ('/devices','/api/sharing','/pair','/devices/ca.cer','/devices/qr.js'):
            with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                self.get(path)
            self.assertEqual(error.exception.code,404)
        request=Request(self.url+'/api/sharing',data=b'{}',headers={
            'Content-Type':'application/json','X-Lab-Token':self.boot['token']})
        with self.assertRaises(HTTPError) as error:
            self.http.open(request)
        self.assertEqual(error.exception.code,404)
        with self.assertRaises(HTTPError) as error:
            self.http.open(Request(self.url+'/api/state',headers={'Host':'example.invalid'}))
        self.assertEqual(error.exception.code,403)
