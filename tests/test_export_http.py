"""Exercise exports/settings over HTTP using blank temporary notebooks."""
import base64
import hashlib
import io
import json
from http.client import HTTPConnection, HTTPSConnection
from ipaddress import ip_network
import ssl
from urllib.parse import urlencode, urlsplit
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from server import make_server
from store import current_time


class ExportHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.server = make_server(Path(self.temp.name) / 'data', 0)
        self.addCleanup(self.server.server_close)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.boot = self.request('/api/state')[1]

    def request(self, path, data=None, headers=None):
        conn = HTTPConnection('127.0.0.1', self.server.server_port, timeout=15)
        hdr = {'Content-Type':'application/json'}
        if hasattr(self, 'boot'):
            hdr['X-Lab-Token'] = self.boot['token']
        hdr.update(headers or {})
        try:
            conn.request('GET' if data is None else 'POST', path,
                         None if data is None else json.dumps(data), hdr)
            res = conn.getresponse()
            body = res.read()
            return res.status, json.loads(body) if res.headers.get_content_type() == 'application/json' else body
        finally:
            conn.close()

    def record(self):
        store = self.server.store
        state = store.mutate('lab_record_save', {'type':'flow', 'variant':'assay', 'title':'Synthetic assay',
            'record_date':current_time().date().isoformat(), 'status':'draft', 'data':{},
            'tables':{}, 'files':[], 'cell_sources':[], 'record_refs':[]}, store.state()['revision'])
        return state['lab_records'][-1]

    def test_backup_destination_open_picker_and_download(self):
        target = str((Path(self.temp.name) / 'custom').resolve())
        self.assertEqual(self.request('/api/backup-dir')[0], 200)
        status, info = self.request('/api/backup-dir', {'path':target})
        self.assertEqual(status, 200)
        self.assertEqual(info['backup_dir'], target)
        with patch('server.open_local_directory', return_value=Path(target)) as opener:
            self.assertEqual(self.request('/api/backup-dir/open', {})[1], {'opened':target})
            opener.assert_called_once_with(Path(target))
        with patch('server.pick_local_directory', return_value=None):
            self.assertEqual(self.request('/api/backup-dir/pick', {})[1], {'cancelled':True})
        status, backup = self.request('/api/backup', {})
        self.assertEqual(status, 200)
        self.assertEqual(self.request('/api/backup-status')[1]['last_backup'], backup['filename'])
        status, blob = self.request(backup['url'])
        self.assertEqual(status, 200)
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            digest = archive.read('original-file.sha256').decode().split()[0]
            self.assertEqual(digest, hashlib.sha256(archive.read('culture.sqlite3')).hexdigest())
        self.assertFalse(self.request('/api/backup-dir', {'reset':True})[1]['is_custom_backup_dir'])

    def test_word_versions_and_direct_issue_protection(self):
        record = self.record()
        store = self.server.store
        payload = {'record_id':record['id'], 'version':record['version'],
                   'record_updated_at':record['updated_at'], 'revision':store.state()['revision']}
        self.assertIn('word_format', self.boot)
        self.assertEqual(self.request('/api/lab/word', {**payload,'version':-1})[0], 409)
        status, result = self.request('/api/lab/word', payload)
        self.assertEqual(status, 200, result)
        blob = base64.b64decode(result['document'])
        self.assertTrue(zipfile.is_zipfile(io.BytesIO(blob)))
        self.assertEqual(result['edition']['id'], hashlib.sha256(blob).hexdigest())
        status, archived = self.request('/api/command', {'action':'word_archive',
            'payload':{'edition':result['edition']}, 'revision':store.state()['revision']})
        self.assertEqual(status, 200, archived)
        self.assertTrue(archived['state']['word_editions'][0]['archived_at'])
        snapshot = store.snapshot()
        before = store.state()
        status, historical = self.request('/api/lab/word', {**payload, 'snapshot':snapshot['id']})
        self.assertEqual(status, 200, historical)
        self.assertNotIn('state', historical)
        self.assertEqual(store.state(), before)
        self.assertEqual(self.request('/api/command', {'action':'word_issue', 'payload':{},
                         'revision':store.state()['revision']})[0], 400)

    def test_template_catalogue_and_strict_upload(self):
        status, catalogue = self.request('/api/word-templates')
        self.assertEqual(status, 200)
        template = catalogue['templates'][0]
        self.assertNotIn('file_path', template)
        status, blob = self.request('/api/word-templates/'+template['id']+'/download')
        self.assertEqual(status, 200)
        for content in ('not base64!', base64.b64encode(b'not a zip').decode()):
            self.assertEqual(self.request('/api/word-templates/import', {'name':'Synthetic',
                'filename':'synthetic.docx', 'content_base64':content})[0], 400)
        status, result = self.request('/api/word-templates/import', {'name':'Synthetic',
            'filename':'synthetic.docx', 'content_base64':base64.b64encode(blob).decode()})
        self.assertEqual(status, 200, result)
        template_id = result['template']['id']
        self.assertEqual(self.request('/api/word-templates/default', {'template_id':template_id})[0], 200)
        backup = self.request('/api/backup', {})[1]
        self.assertEqual(self.request('/api/word-templates/delete', {'template_id':template_id})[0], 200)
        with zipfile.ZipFile(io.BytesIO(self.request(backup['url'])[1])) as archive:
            self.assertEqual(archive.read('word_templates/'+template_id+'.docx'), blob)
            registry = json.loads(archive.read('word_templates/registry.json'))
            self.assertEqual(registry['default_template_id'], template_id)
        self.assertEqual(self.request('/api/word-templates/import', {}, {'Content-Length':str(14*1024*1024+1)})[0], 400)


    def test_paired_mobile_can_export_but_cannot_manage_local_settings(self):
        address = '127.0.0.1'
        network = ip_network(address+'/32')
        interface = {'subnet':str(network), 'kind':'lan', 'label':'Test', 'interface':'loopback'}
        for fixture in (patch('mobile_access.lan_interfaces', return_value={address:interface}),
                        patch('mobile_access.tailscale_status', return_value={}),
                        patch('mobile_tls.NETWORKS', (network,))):
            fixture.start()
            self.addCleanup(fixture.stop)
        status, sharing = self.request('/api/sharing', {'action':'start', 'address':address})
        self.assertEqual(status, 200, sharing)
        origin = sharing['url']
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.load_verify_locations(cadata=self.request('/devices/ca.cer')[1])
        def mobile(path, body=None, headers=None):
            connection = HTTPSConnection(address, urlsplit(origin).port, context=context, timeout=15)
            try:
                connection.request('GET' if body is None else 'POST', path, body, headers or {})
                response = connection.getresponse()
                return response.status, response.headers, response.read()
            finally:
                connection.close()
        form = urlencode({'name':'Test tablet', 'code':sharing['code']})
        code, headers, _ = mobile('/pair', form, {'Origin':origin, 'Content-Type':'application/x-www-form-urlencoded'})
        self.assertEqual(code, 303)
        cookie = headers['Set-Cookie'].split(';', 1)[0]
        _, _, body = mobile('/api/state', headers={'Cookie':cookie})
        boot = json.loads(body)
        self.assertTrue({'backup_dir','default_backup_dir','data_dir','last_backup'}.isdisjoint(boot))
        for path in ('/api/backup-dir','/api/backup-status'):
            self.assertEqual(mobile(path, headers={'Cookie':cookie})[0], 403)
        self.assertEqual(mobile('/api/word-templates', headers={'Cookie':cookie})[0], 200)
        hdr = {'Origin':origin, 'Cookie':cookie, 'Content-Type':'application/json', 'X-Lab-Token':boot['token']}
        for path in ('/api/backup-dir','/api/backup-dir/open','/api/backup-dir/pick',
                     '/api/word-templates/import','/api/word-templates/default','/api/word-templates/delete'):
            self.assertEqual(mobile(path, '{}', hdr)[0], 403)
        record = self.record()
        payload = {'record_id':record['id'], 'version':record['version'],
                   'record_updated_at':record['updated_at'], 'revision':self.server.store.state()['revision']}
        code, _, body = mobile('/api/lab/word', json.dumps(payload), hdr)
        self.assertEqual(code, 200, body)
        self.assertIn('document', json.loads(body))


if __name__ == '__main__':
    unittest.main()
