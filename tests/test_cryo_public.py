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
        changed = self.db.mutate('wells', {'id': cid, 'wells': ['A1'],
            'patch': {'cell': 'Changed sample'}}, self.revision)
        self.revision = changed['revision']
        lot_id = state['frozen_batches'][-1]['id']
        copied = self.run_command('stock_create', **stock, source_lot_id=lot_id)
        self.assertEqual(copied['frozen_batches'][-1]['sources'], [source])
        with self.assertRaises(ValueError):
            self.run_command('stock_create', **stock, source_lot_id='missing-id')
        with self.assertRaises(ValueError):
            self.run_command('stock_create', **stock, source_lot_id=lot_id, source={'id':cid, 'well':'A1'})
        self.assertEqual(self.db.state(), copied)

    def test_split_one_slot_preserves_quantities_and_prior_withdrawal(self):
        from cryo_storage import batch_remaining, batch_unplaced

        state = self.run_command('setup_preset', device_name='Device A', box_count=1, rows=2, cols=2)
        box_id = state['cryo_storage']['boxes'][0]['id']
        first, second = [dict(box_id=box_id, slot=key) for key in ('A1', 'A2')]
        state = self.run_command('stock_create', name='Sample', at='2020-01-01', vials=4,
                                 placements=[first, second], labels='01、02', storage_stage='gradient',
                                 cell_kind='Custom category', resistance_tags='Label A，Label B;label a')
        lot_id = state['frozen_batches'][0]['id']
        state = self.run_command('withdraw_vials', lot_id=lot_id, at='2020-01-02T09:00',
                                 vials=1, slots=[second])
        original_event = state['frozen_withdrawals'][0]
        for invalid in ([first, first], [second], None):
            with self.assertRaises(ValueError):
                self.run_command('batch_update', lot_id=lot_id, split_slots=invalid, name='Oops')
        with self.assertRaises(ValueError):
            self.run_command('batch_update', lot_id=lot_id, split_slots=[first],
                             slot_update={**second, 'vial_label': 'Wrong slot'})
        self.assertEqual(self.db.state(), state)

        state = self.run_command('batch_update', lot_id=lot_id, split_slots=[first], cell_kind='Group B',
                                 at='2020-01-03', special_treatments=['WT'], notes='Edited separately',
                                 slot_update={**first, 'vial_label': 'Edited label'})
        original, child = state['frozen_batches']
        self.assertEqual((original['vials'], child['vials']), (3, 1))
        self.assertEqual((batch_remaining(state, original), batch_remaining(state, child)), (2, 1))
        self.assertEqual((batch_unplaced(state, original), batch_unplaced(state, child)), (2, 0))
        self.assertEqual(original['storage_stage'], 'gradient')
        self.assertEqual((original['cell_kind'], child['cell_kind']), ('Custom category', 'Group B'))
        self.assertEqual(original['special_treatments'], [])
        self.assertEqual(child['special_treatments'], ['WT'])
        self.assertEqual(child['resistance_tags'], ['Label A', 'Label B'])
        self.assertEqual(child['split_from_lot_id'], lot_id)
        self.assertEqual(state['frozen_withdrawals'], [original_event])
        self.assertEqual(original_event['lot_id'], original['id'])
        self.assertEqual(original_event['slots'][0]['vial_label'], '02')
        slot = state['cryo_storage']['boxes'][0]['slots']['A1']
        self.assertEqual((slot['batch_id'], slot['vial_label']), (child['id'], 'Edited label'))

        state = self.run_command('batch_update', lot_id=child['id'], split_slots=[first],
                                 resistance_tags=[], special_treatments=[])
        self.assertEqual(len(state['frozen_batches']), 2)
        self.assertEqual(state['frozen_batches'][-1]['id'], child['id'])
        self.assertEqual(state['frozen_batches'][-1]['resistance_tags'], [])
        with self.assertRaises(ValueError):
            self.run_command('batch_update', lot_id=lot_id, at='2020-01-04')
        self.assertEqual(self.db.state(), state)
