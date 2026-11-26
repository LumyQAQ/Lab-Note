"""Cached read models reflect committed commands from independent writers."""
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1] / 'app'
sys.path.insert(0, str(APP))
import workday
from store import Store, current_time


class HistoryCacheTests(unittest.TestCase):
    def test_incremental_reads_undo_and_snapshot_revisions(self):
        with tempfile.TemporaryDirectory() as directory:
            reader = Store(directory)
            writer = Store(directory)
            self.assertEqual(reader.medium_recipes(), [])
            self.assertEqual(reader.workday()['timeline'], [])
            state = writer.mutate('create', {'type': '6孔板', 'name': 'Test plate'}, 0)
            cid = state['containers'][0]['id']
            with patch.object(workday, 'event_entry', wraps=workday.event_entry) as project:
                entry = reader.workday()['timeline'][0]
                entry['containers'][0]['name'] = 'changed locally'
                self.assertEqual(reader.workday()['timeline'][0]['containers'][0]['name'], 'Test plate')
                self.assertEqual(project.call_count, 1)
                writer.mutate('wells', {'id': cid, 'wells': ['A1'], 'patch': {
                    'cell': 'Test cell', 'batch': 'test', 'kind': '细胞系', 'anchor': '传代',
                    'day0': current_time().date().isoformat(), 'medium': {'base': 'Test base'}}}, 1)
                writer.mutate('check', {'id': cid}, 2)
                activities = reader.activities(cid)
                activities[0]['container_ids'].clear()
                self.assertEqual(reader.activities(cid)[0]['container_ids'], [cid])
                self.assertEqual(project.call_count, 3)

            catalogue = reader.medium_recipes()
            catalogue[0]['base'] = 'changed locally'
            self.assertEqual(reader.medium_recipes()[0]['base'], 'Test base')
            subprocess.run([sys.executable, '-c',
                            "from store import Store; import sys; s=Store(sys.argv[1]); "
                            "s.mutate('undo', {'target_event_id': 3}, 3); "
                            "s.mutate('undo', {'target_event_id': 2}, 4)",
                            directory], cwd=APP, check=True)
            self.assertEqual(reader.medium_recipes(), [])
            self.assertTrue(reader.activities(cid)[0]['undone'])
            old = reader.activities(cid, max_revision=3)[0]
            self.assertFalse(old['undone'])
            self.assertIsNone(old['undone_at'])
            self.assertEqual(reader.activities(cid, max_revision=1), [])
