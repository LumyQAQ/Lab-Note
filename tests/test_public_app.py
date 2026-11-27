"""Verify a clean installation using a private temporary directory."""
import json
from http.client import HTTPSConnection
from ipaddress import ip_network
from pathlib import Path
import re
import ssl
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'app'))
from server import make_server


class PublicNotebookTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        server=make_server(folder.name,0,mobile_port=0)
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

    def desktop_action(self, **action):
        request = Request(self.url+'/api/sharing', data=json.dumps(action).encode(), headers={
            'Content-Type':'application/json', 'X-Lab-Token':self.boot['token']})
        with self.http.open(request, timeout=60) as response:
            return json.load(response)

    def test_sharing_off_by_default(self):
        with patch('mobile_access.lan_interfaces', return_value={}), patch('mobile_access.tailscale_status', return_value={}):
            status = self.get('/api/sharing')
        self.assertFalse(status['active'])
        self.assertFalse(status['auto_start'])
        self.assertFalse(status['devices'])
        self.assertFalse(self.boot['mobile_client'])
        self.assertFalse((Path(self.boot['data_dir'])/'mobile-access').exists())
        for path in ('/devices', '/devices.js', '/devices.css', '/devices/qr.js', '/sw.js'):
            with self.subTest(path=path):
                self.assertTrue(self.get(path))
        with self.assertRaises(HTTPError) as error:
            self.get('/devices/ca.cer')
        self.assertEqual(error.exception.code,404)
        request=Request(self.url+'/api/sharing', data=b'{"action":"code"}', headers={'Content-Type':'application/json'})
        with self.assertRaises(HTTPError) as error:
            self.http.open(request)
        self.assertEqual(error.exception.code,403)
        with self.assertRaises(HTTPError) as error:
            self.http.open(Request(self.url+'/api/state',headers={'Host':'example.invalid'}))
        self.assertEqual(error.exception.code,403)

    def test_paired_device_reads_writes_and_revocation(self):
        # Use the production TLS and pairing flow, entirely within a temporary loopback fixture.
        address = '127.0.0.1'
        network = ip_network(address+'/32')
        interface = {'subnet':str(network), 'kind':'lan', 'label':'Test', 'interface':'loopback'}
        for fixture in (patch('mobile_access.lan_interfaces', return_value={address:interface}),
                        patch('mobile_access.tailscale_status', return_value={}),
                        patch('mobile_tls.NETWORKS', (network,))):
            fixture.start()
            self.addCleanup(fixture.stop)
        status = self.desktop_action(action='start', address=address)
        origin = status['url']
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.load_verify_locations(cadata=self.get('/devices/ca.cer'))

        def request(path, body=None, **headers):
            connection = HTTPSConnection(address, urlsplit(origin).port, context=context, timeout=10)
            try:
                connection.request('POST' if body is not None else 'GET', path, body, headers)
                response = connection.getresponse()
                return response.status, response.headers, response.read()
            finally:
                connection.close()

        self.assertEqual(request('/')[0], 200)
        self.assertEqual(request('/api/state')[0], 401)
        form = urlencode({'name':'Test tablet', 'code':status['code']})
        form_headers = {'Origin':origin, 'Content-Type':'application/x-www-form-urlencoded'}
        status_code, headers, _ = request('/pair', form, **form_headers)
        self.assertEqual(status_code, 303)
        cookie_header = headers['Set-Cookie']
        for flag in ('HttpOnly', 'Secure', 'SameSite=Strict'):
            self.assertIn(flag, cookie_header)
        cookie = cookie_header.split(';', 1)[0]
        self.assertEqual(request('/pair', form, **form_headers)[0], 400)
        code, _, body = request('/api/state', Cookie=cookie)
        self.assertEqual(code, 200)
        mobile = json.loads(body)
        self.assertTrue(mobile['mobile_client'])
        self.assertNotEqual(mobile['token'], self.boot['token'])
        self.assertTrue({'data_dir','download_url','last_backup','github_repo'}.isdisjoint(mobile))
        self.assertEqual(mobile['state'], self.state)
        for path in ('/devices', '/devices/qr.js', '/devices/ca.cer', '/api/sharing', '/api/health',
                     '/api/version', '/api/update-check', '/api/storage-stats', '/api/backups/test'):
            with self.subTest(path=path):
                self.assertEqual(request(path, Cookie=cookie)[0], 403)
        write_headers = {'Origin': origin, 'Cookie': cookie, 'Content-Type':'application/json', 'X-Lab-Token':mobile['token']}
        for path in ('/api/stop', '/api/backup', '/api/compact', '/api/sharing'):
            with self.subTest(path=path):
                self.assertEqual(request(path, '{}', **write_headers)[0], 403)
        payload = json.dumps({'revision':self.state['revision']})
        for key in ('Origin', 'X-Lab-Token'):
            with self.subTest(missing=key):
                self.assertEqual(request('/api/snapshot', payload, **{k:v for k,v in write_headers.items() if k != key})[0], 403)
        second_code = self.desktop_action(action='code')['code']
        second_form = urlencode({'name':'Test phone', 'code':second_code})
        code, headers, _ = request('/pair', second_form, **form_headers)
        self.assertEqual(code, 303)
        second_cookie = headers['Set-Cookie'].split(';', 1)[0]
        mismatched = {**write_headers, 'Cookie':second_cookie}
        self.assertEqual(request('/api/snapshot', payload, **mismatched)[0], 403)
        code, _, body = request('/api/snapshot', payload, **write_headers)
        self.assertEqual(code, 200, body)
        self.assertEqual(self.get('/api/snapshots')[0]['id'], json.loads(body)['id'])
        device = self.get('/api/sharing')['devices'][0]
        self.desktop_action(action='revoke', device_id=device['id'])
        self.assertEqual(request('/api/state', Cookie=cookie)[0], 401)
        self.assertEqual(request('/api/state', Cookie=second_cookie)[0], 200)
        self.assertFalse(self.desktop_action(action='stop')['active'])
