"""Synthetic records exercise the public catalogue and overview shortcuts."""
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from medium import merge_medium, recipe_catalogue
from store import current_time, Store


class MediumShortcutTests(unittest.TestCase):
    def test_catalogue_preserves_records_and_distinct_units(self):
        row = {'name': 'Test component', 'concentration': '1.0', 'unit': 'µg/mL'}
        original = merge_medium(None, {'base': 'RPMI-1640', 'cytokines': [row]})
        explicit = merge_medium(original, {'base': 'rpmi 1640', 'extra': 'no',
            'cytokines': [{**row, 'concentration': '1', 'unit': 'μg/mL'}]})
        distinct = merge_medium(explicit, {'cytokines': [{**row, 'unit': 'mg/mL'}]})
        records = [original, explicit, distinct]
        unchanged = deepcopy(records)

        suggestions = recipe_catalogue(records)
        self.assertEqual(len(suggestions), 2)
        self.assertEqual(suggestions[0], {**explicit, 'base': 'RPMI 1640'})
        self.assertEqual(suggestions[1]['cytokines'], distinct['cytokines'])
        suggestions[0]['cytokines'].clear()
        self.assertEqual(records, unchanged)

    def test_topup_preserves_mixture_and_supports_undo(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(folder)
            self.assertEqual(store.medium_recipes(), [])
            now = current_time().replace(tzinfo=None).isoformat(timespec='minutes')
            state = store.mutate('create', {'type': '6孔板', 'name': 'Test plate'}, 0)
            cid = state['containers'][0]['id']
            state = store.mutate('wells', {'id': cid, 'wells': ['A1','A2'], 'patch': {
                'cell': 'Test cell', 'batch': 'test', 'kind': '细胞系', 'anchor': '传代',
                'day0': now[:10], 'medium': {'base': 'Test base'}}}, state['revision'])
            before = deepcopy(state['containers'][0]['wells'])
            payload = {'id': cid, 'wells': ['A1'], 'kind': 'topup', 'details': 'Test note',
                       'volume_value': '1', 'volume_unit': 'mL', 'occurred_at': now, 'confirm_checked': True}
            with self.assertRaises(ValueError):
                store.mutate('activity', {**payload, 'exchange_kind': 'full'}, state['revision'])
            state = store.mutate('activity', payload, state['revision'])
            self.assertEqual(state['containers'][0]['wells'], before)
            self.assertEqual(state['containers'][0]['checked_date'], now[:10])
            info = store.undo_info()
            self.assertEqual(info['title'], '补液')
            self.assertIn('1 mL', info['summary'])
            entry = next(row for row in store.workday()['timeline'] if row['event_id'] == info['event_id'])
            self.assertEqual(entry['wells'], ['A1'])
            state = store.mutate('undo', {'target_event_id': info['event_id']}, state['revision'])
            self.assertFalse(state['containers'][0]['checked_date'])
            self.assertEqual(state['containers'][0]['wells'], before)
