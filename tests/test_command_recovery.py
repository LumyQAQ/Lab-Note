import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from server import make_server
from store import Conflict, Store


class ScopedConflictAndIdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lab-scoped-conflict-')
        self.store = Store(Path(self.tmp.name))
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        self.tmp.cleanup()

    def _create_plate(self, name):
        st = self.store.state()
        after = self.store.mutate('create', {'name': name, 'type': '24孔板'}, st['revision'])
        return after['containers'][-1]['id'], after

    def test_unrelated_vs_scope_changed_409_diagnosis(self):
        c1, st = self._create_plate('Plate A')
        c2, st = self._create_plate('Plate B')
        base_rev = st['revision']
        # Mutate Plate B (unrelated to Plate A)
        st2 = self.store.mutate('wells', {
            'id': c2, 'wells': ['A1'],
            'patch': {'cell': 'B-cell', 'kind': '细胞系', 'anchor': '复苏', 'day0': '2020-01-01'}
        }, base_rev)
        # Try saving to Plate A using stale base_rev -> 409 unrelated
        with self.assertRaises(Conflict) as ctx:
            self.store.mutate('wells', {
                'id': c1, 'wells': ['A1'],
                'patch': {'cell': 'A-cell', 'kind': '细胞系', 'anchor': '复苏', 'day0': '2020-01-01'}
            }, base_rev)
        self.assertIsNotNone(ctx.exception.conflict)
        self.assertEqual(ctx.exception.conflict['level'], 'unrelated')
        self.assertEqual(ctx.exception.conflict['current_revision'], st2['revision'])
        self.assertEqual(ctx.exception.conflict['changed_containers'], [])

        # Now try saving to Plate B using stale base_rev -> 409 scope_changed
        with self.assertRaises(Conflict) as ctx2:
            self.store.mutate('wells', {
                'id': c2, 'wells': ['A2'],
                'patch': {'cell': 'B2-cell', 'kind': '细胞系', 'anchor': '复苏', 'day0': '2020-01-01'}
            }, base_rev)
        self.assertEqual(ctx2.exception.conflict['level'], 'scope_changed')
        self.assertIn('Plate B', ctx2.exception.conflict['changed_containers'])

    def test_transfer_scoped_conflict_and_idempotent_retry(self):
        src, st = self._create_plate('Source')
        other, st = self._create_plate('Other')
        st = self.store.mutate('wells', {
            'id': src, 'wells': ['A1'],
            'patch': {'cell': 'Demo A', 'kind': '细胞系', 'anchor': '复苏', 'day0': '2020-01-01'}
        }, st['revision'])
        base_rev = st['revision']
        # Unrelated change on Other
        st_other = self.store.mutate('wells', {
            'id': other, 'wells': ['B1'],
            'patch': {'cell': 'Demo B', 'kind': '细胞系', 'anchor': '复苏', 'day0': '2020-01-01'}
        }, base_rev)
        transfer_payload = {
            'mode': 'passage',
            'at': '2020-01-02T10:00',
            'sources': [{'id': src, 'well': 'A1', 'role': '', 'amount': ''}],
            'new_containers': [{'key': 'new-1', 'name': 'Child', 'type': '24孔板', 'quantity': 1, 'location': ''}],
            'targets': [{
                'new_key': 'new-1',
                'wells': ['A1'], 'source_indices': [0], 'cultivation_mode': 'same'
            }],
            'end_sources': [], 'notes': ''
        }
        # Stale base_rev against unrelated Other -> unrelated conflict
        with self.assertRaises(Conflict) as ctx:
            self.store.mutate('transfer', transfer_payload, base_rev, client_request_id='req-001')
        self.assertEqual(ctx.exception.conflict['level'], 'unrelated')
        self.assertEqual(self.store.command_status('req-001')['committed'], False)

        # Retry at synced revision with same client_request_id -> commits once
        st_done = self.store.mutate('transfer', transfer_payload, st_other['revision'], client_request_id='req-001')
        self.assertEqual(st_done['revision'], st_other['revision'] + 1)
        status = self.store.command_status('req-001')
        self.assertEqual(status['committed'], True)
        self.assertEqual(status['action'], 'transfer')

        # Replay with the same client_request_id (even with old revision!) -> idempotent, NO duplicate transfer
        st_replay = self.store.mutate('transfer', transfer_payload, st_other['revision'], client_request_id='req-001')
        self.assertEqual(st_replay['revision'], st_done['revision'])
        self.assertEqual(len(self.store.transfers(src)), 1)

        # Undo the transfer -> command_status reports committed=False, undone=True
        undo_id = self.store.undo_info()['event_id']
        self.store.mutate('undo', {'target_event_id': undo_id}, st_done['revision'])
        after_undo = self.store.command_status('req-001')
        self.assertEqual(after_undo['committed'], False)
        self.assertEqual(after_undo['undone'], True)
        with self.assertRaisesRegex(Conflict, '已被撤销'):
            self.store.mutate('transfer', transfer_payload, st_done['revision'], client_request_id='req-001')

    def test_same_request_requires_same_payload_even_after_restart(self):
        body = {'name': 'A', 'type': 'T25'}
        self.store.mutate('create', body, 0, client_request_id='one')
        store = Store(Path(self.tmp.name))
        replay = store.mutate('create', dict(reversed(list(body.items()))), 0, client_request_id='one')
        self.assertEqual(replay['revision'], 1)
        with self.assertRaisesRegex(ValueError, '不同内容'):
            store.mutate('create', {**body, 'name': 'B'}, 1, client_request_id='one')
        self.assertEqual(len(store.events()), 1)

    def test_http_command_status_and_409_payload(self):
        server = make_server(Path(self.tmp.name), 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_address[1]}'
        try:
            boot = json.loads(self.http.open(base + '/api/state').read())
            token = boot['token']

            def post(path, body):
                req = urllib.request.Request(
                    base + path,
                    data=json.dumps(body).encode(),
                    headers={'Content-Type': 'application/json', 'X-Lab-Token': token},
                    method='POST'
                )
                with self.http.open(req) as resp:
                    return resp.status, json.loads(resp.read())

            _, r1 = post('/api/command', {
                'action': 'create', 'payload': {'name': 'HTTP A', 'type': '24孔板'},
                'revision': boot['state']['revision'], 'client_request_id': 'http-req-1'
            })
            st1 = r1['state']
            status = json.loads(self.http.open(base + '/api/command-status?request_id=http-req-1').read())
            self.assertEqual(status['committed'], True)
            self.assertEqual(status['action'], 'create')

            # Idempotent replay over HTTP
            code, r1_again = post('/api/command', {
                'action': 'create', 'payload': {'name': 'HTTP A', 'type': '24孔板'},
                'revision': boot['state']['revision'], 'client_request_id': 'http-req-1'
            })
            self.assertEqual(code, 200)
            self.assertEqual(r1_again['state']['revision'], st1['revision'])
            self.assertEqual(len(r1_again['state']['containers']), 1)

            # Create second container and check 409 conflict JSON over HTTP
            _, r2 = post('/api/command', {
                'action': 'create', 'payload': {'name': 'HTTP B', 'type': '24孔板'},
                'revision': st1['revision']
            })
            cid_a = st1['containers'][0]['id']
            req = urllib.request.Request(
                base + '/api/command',
                data=json.dumps({
                    'action': 'wells',
                    'payload': {'id': cid_a, 'wells': ['A1'], 'patch': {'cell': 'X', 'kind': '细胞系', 'anchor': '复苏', 'day0': '2020-01-01'}},
                    'revision': st1['revision']
                }).encode(),
                headers={'Content-Type': 'application/json', 'X-Lab-Token': token},
                method='POST'
            )
            with self.assertRaises(urllib.error.HTTPError) as err:
                self.http.open(req)
            self.assertEqual(err.exception.code, 409)
            body = json.loads(err.exception.read())
            self.assertEqual(body['conflict']['level'], 'unrelated')
            self.assertEqual(body['conflict']['current_revision'], r2['state']['revision'])
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
