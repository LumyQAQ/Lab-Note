"""Historical state, storage maintenance and migration on synthetic databases."""
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import store as store_module
from state_codec import loads_state_blob, pack_state_blob, unpack_state_blob
from store import Conflict, RECENT_EVENTS, Store


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)

    def test_codec_round_trip(self):
        raw = '{"label":"空白测试"}'
        packed = pack_state_blob(raw)
        for value in (raw, raw.encode(), packed, bytearray(packed), memoryview(packed)):
            self.assertEqual(unpack_state_blob(value), raw)
            self.assertEqual(loads_state_blob(value), json.loads(raw))
            self.assertEqual(pack_state_blob(value), packed)

    def test_concurrent_legacy_migration_and_writes(self):
        with sqlite3.connect(self.directory / 'culture.sqlite3') as conn:
            conn.execute('CREATE TABLE events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, '
                         'payload TEXT NOT NULL, before_state TEXT NOT NULL, after_state TEXT NOT NULL)')
            conn.execute('CREATE TABLE current_state (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
            before = '{"revision":0,"containers":[]}'
            after = '{"revision":1,"containers":[]}'
            conn.execute('INSERT INTO events VALUES(1,?,?,?,?,?)',
                         ('2020-01-01T12:00:00', 'confirm', '{}', before, after))
            conn.execute('INSERT INTO current_state VALUES(1,?)', (after,))
        start = threading.Barrier(2)
        write = threading.Barrier(2)

        def writer(name):
            start.wait(timeout=5)
            db = Store(self.directory)
            write.wait(timeout=5)
            try:
                db.mutate('create', {'name': name, 'type': 'T25'}, 1)
            except Conflict:
                return False
            return True

        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertCountEqual(pool.map(writer, ['test-A', 'test-B']), [False, True])
        db = Store(self.directory)
        with db.connect() as conn:
            self.assertIsNone(conn.execute('SELECT after_rev FROM events WHERE id=1').fetchone()[0])
        self.assertEqual(len(db.workday()['timeline']), 1)
        self.assertEqual(len(db.activities(max_revision=1)), 1)
        self.assertEqual(db.compact_storage(keep_recent=1)['compressed_events'], 1)
        self.assertEqual(len(db.activities(max_revision=1)), 1)
        with db.connect() as conn:
            row = conn.execute('SELECT after_rev,after_state FROM events WHERE id=1').fetchone()
            self.assertEqual(row['after_rev'], 1)
            self.assertEqual(unpack_state_blob(row['after_state']), after)

    def test_aging_compaction_undo_and_restorable_backup(self):
        db = Store(self.directory)
        reader = Store(self.directory)
        state = db.mutate('create', {'type': 'T25', 'name': 'First'}, 0)
        cid = state['containers'][0]['id']
        for revision in range(1, RECENT_EVENTS + 2):
            db.mutate('rename', {'id': cid, 'name': 'test-' + str(revision)}, revision)
        snap = db.snapshot()
        state = db.state()
        events = db.events()
        self.assertEqual(db.storage_stats()['compressed_events'], 2)
        previous_timeline = reader.workday()['timeline']
        result = db.compact_storage(keep_recent=0)
        self.assertEqual(result['compressed_events'], RECENT_EVENTS)
        self.assertEqual(result['compressed_snapshots'], 1)
        self.assertEqual(result['stats']['compressed_events'], len(events))
        self.assertEqual(db.compact_storage(keep_recent=0)['compressed_events'], 0)
        self.assertEqual(reader.workday()['timeline'], previous_timeline)
        self.assertEqual(reader.workday()['snapshot']['revision'], state['revision'])
        self.assertEqual(reader.get_snapshot(snap['id']), snap)
        self.assertEqual(reader.events(), events)
        self.assertEqual(reader.state(), state)
        target = db.backup()
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        self.assertEqual(target.with_suffix('.sha256').read_text().split()[0], digest)
        restore_path = self.directory / 'restored'
        restore_path.mkdir()
        shutil.copyfile(target, restore_path / 'culture.sqlite3')
        restored = Store(restore_path)
        self.assertEqual(restored.get_snapshot(snap['id']), snap)
        self.assertEqual(restored.events(), events)
        undo_id = restored.undo_info()['event_id']
        changed = restored.mutate('undo', {'target_event_id': undo_id}, state['revision'])
        self.assertEqual(changed['containers'][0]['name'], 'test-' + str(RECENT_EVENTS))
        self.assertTrue(restored.events()[1]['undone'])
        with self.assertRaises(Conflict) as caught:
            restored.mutate('rename', {'id': cid, 'name': 'stale'}, 1)
        self.assertEqual(caught.exception.conflict['level'], 'scope_changed')

    def test_history_catalogue_tracks_withdrawals_across_compaction_and_undo(self):
        db = Store(self.directory)
        reader = Store(self.directory)
        state = db.mutate('cryo_stock_create', {'name': 'Test stock', 'at': '2020-01-01',
                          'storage_stage': 'unassigned', 'vials': 1}, 0)
        self.assertEqual(reader.medium_recipes(), [])
        db.mutate('cryo_withdraw_vials', {'lot_id': state['frozen_batches'][0]['id'],
                  'vials': 1, 'mode': 'thaw', 'medium': {'base': 'Test base'}}, 1)
        self.assertEqual(reader.medium_recipes()[0]['base'], 'Test base')
        db.compact_storage(keep_recent=0)
        self.assertEqual(Store(self.directory).medium_recipes(), reader.medium_recipes())
        self.assertIn('Test base', reader.medium_history()['bases'])
        db.mutate('undo', {'target_event_id': db.undo_info()['event_id']}, 2)
        self.assertEqual(reader.medium_recipes(), [])
        self.assertEqual(reader.medium_history()['bases'], [])

    def test_compaction_failure_rolls_back_earlier_rows(self):
        db = Store(self.directory)
        for revision in range(2):
            db.mutate('create', {'name': str(revision), 'type': 'T25'}, revision)
        with patch.object(store_module, 'pack_state_blob', side_effect=[b'a', b'b', RuntimeError('interrupted')]):
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                db.compact_storage(keep_recent=0)
        self.assertEqual(db.storage_stats()['compressed_events'], 0)
        self.assertEqual(len(db.events()), 2)
