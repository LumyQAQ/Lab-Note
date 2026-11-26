"""Exercise public inventory through the revision-checked SQLite command path."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from store import Conflict, Store


class CryoInventoryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db = Store(temp.name)
        self.revision = self.db.state()['revision']

    def run_command(self, action, **payload):
        state = self.db.mutate('cryo_' + action, payload, self.revision)
        self.revision = state['revision']
        return state

    def test_full_inventory_lifecycle_and_atomic_failure(self):
        initial = self.db.state()
        self.assertFalse(initial.get('frozen_batches'))
        self.assertFalse(initial.get('cryo_storage', {}).get('devices'))
        s = self.run_command('setup_preset', device_name='Inventory A', use_rack=True,
                             rack_name='Rack A', box_count=1, rows=2, cols=2)
        box = s['cryo_storage']['boxes'][0]
        self.assertEqual(box['rack_id'], s['cryo_storage']['racks'][0]['id'])
        first = {'box_id': box['id'], 'slot': 'A1', 'vial_label': '001'}
        second = {'box_id': box['id'], 'slot': 'A2'}
        s = self.run_command('stock_create', name='Sample A', at='2020-01-01',
                             storage_stage='gradient', vials=2, placements=[first])
        lot_id = s['frozen_batches'][0]['id']
        self.assertEqual(s['frozen_batches'][0]['storage_stage'], 'gradient')
        with self.assertRaises(ValueError):
            self.run_command('place_vials', lot_id=lot_id, placements=[first])
        with self.assertRaises(Conflict):
            self.db.mutate('cryo_place_vials', {'lot_id': lot_id, 'placements':[second]}, self.revision - 1)
        self.assertEqual(self.db.state(), s)
        s = self.run_command('place_vials', lot_id=lot_id, placements=[second])
        self.assertEqual(s['frozen_batches'][0]['storage_stage'], 'stored')
        with self.assertRaises(ValueError):
            self.run_command('box_delete', id=box['id'])
        with self.assertRaises(ValueError):
            self.run_command('withdraw_vials', lot_id=lot_id, vials=2, slots=[first], mode='take')
        self.assertEqual(self.db.state(), s)
        move = dict(from_box_id=box['id'], from_slot='A1', to_box_id=box['id'], to_slot='B1')
        self.run_command('move_slots', moves=[move])
        released = dict(box_id=box['id'], slot='B1')
        s = self.run_command('withdraw_vials', lot_id=lot_id, vials=1, slots=[released], mode='take')
        record = s['frozen_withdrawals'][0]
        self.assertFalse(record.get('discarded'))
        self.assertEqual(record['slots'][0]['vial_label'], '001')
        self.assertEqual(set(s['cryo_storage']['boxes'][0]['slots']), {'A2'})
        s = self.run_command('mark_contamination', withdrawal_id=record['id'], notes='Review requested')
        self.assertEqual(s['frozen_withdrawals'][0]['contamination']['notes'], 'Review requested')
        self.run_command('mark_contamination', withdrawal_id=record['id'], clear=True)
        s = self.run_command('discard_vials', lot_id=lot_id, vials=1, slots=[second], reason='Audit')
        self.assertTrue(s['frozen_withdrawals'][-1]['discarded'])
        self.assertEqual(s['cryo_storage']['boxes'][0]['slots'], {})
        self.run_command('box_delete', id=box['id'])

    def test_source_reference_is_explicit_and_verified(self):
        base = self.db.mutate('create', {'name':'Culture A', 'type':'24孔板', 'location':''}, self.revision)
        cid = base['containers'][0]['id']
        base = self.db.mutate('wells', {'id':cid, 'wells':['A1'],
            'patch':{'cell':'Sample A','kind':'细胞系','day0':'2020-01-01','anchor':'传代'}}, base['revision'])
        self.revision = base['revision']
        stock = dict(name='Sample A', at='2020-02-01', vials=1, storage_stage='unassigned')
        state = self.run_command('stock_create', **stock)
        self.assertEqual(state['frozen_batches'][0]['sources'], [])
        with self.assertRaises(ValueError):
            self.run_command('stock_create', **stock, source={'id':cid, 'well':'A2'})
        self.assertEqual(self.db.state(), state)
        state = self.run_command('stock_create', **stock, source={'id':cid, 'well':'A1'})
        source = state['frozen_batches'][-1]['sources'][0]
        self.assertEqual((source['id'], source['well'], source['name']), (cid,'A1','Culture A'))
