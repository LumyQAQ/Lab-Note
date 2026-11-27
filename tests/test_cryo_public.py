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

    def test_numbered_clones_templates_and_print(self):
        from cryo_storage import render_box_print_html, stock_group_remaining_map
        s = self.run_command('setup_preset', device_name='<Device>', rows=2, cols=2, numbering='numeric')
        box = s['cryo_storage']['boxes'][0]['id']
        slots = [dict(box_id=box, slot=k) for k in ['4', '1']]
        stock = dict(name='<Sample>', at='2020-01-01', vials=2, placements=slots, labels='one,two',
                     per_vial_count={'coefficient': '3.20', 'exponent': '-1', 'unit': 'user units'})
        for seq in [{'start': True}, {'start': -1}, [], {'start': 100000}]:
            with self.assertRaises(ValueError):
                self.run_command('stock_create', **stock, subclone_sequence=seq)
        self.assertEqual(self.db.state(), s)
        s = self.run_command('stock_create', **stock, subclone_sequence={'prefix': 'C<', 'start': 0})
        lots = s['frozen_batches']
        self.assertEqual([(x['subclone'], x['labels']) for x in lots], [('C<0', 'one'), ('C<1', 'two')])
        mapping = s['cryo_storage']['boxes'][0]['slots']
        self.assertEqual([mapping[k]['batch_id'] for k in ['4', '1']], [x['id'] for x in lots])
        self.assertEqual(stock_group_remaining_map(s), {x['id']: 1 for x in lots})
        sheet = render_box_print_html(s, box)
        for part in ['&lt;Device&gt;', '&lt;Sample&gt;', 'C&lt;0', '未记录', '剩1', 'A4 landscape']:
            self.assertIn(part, sheet)
        self.assertNotIn('<Sample>', sheet)
        self.assertNotIn('WT', sheet)
        with self.assertRaises(ValueError):
            render_box_print_html(s, 'missing')
        s = self.run_command('template_save', **stock, label='My template', subclone='C<0')
        tmpl = s['cryo_storage']['templates'][0]
        self.assertEqual(tmpl['per_vial_count'], stock['per_vial_count'])
        self.assertEqual(tmpl['subclone'], 'C<0')
        s = self.run_command('template_save', name='Updated', label='MY TEMPLATE')
        self.assertEqual([t['id'] for t in s['cryo_storage']['templates']], [tmpl['id']])
        s = self.run_command('template_delete', id=tmpl['id'])
        self.assertEqual(s['cryo_storage']['templates'], [])
        with self.assertRaises(ValueError):
            self.run_command('delete_slots', slots=[slots[0], slots[0]])
        self.assertEqual(self.db.state(), s)
        s = self.run_command('delete_slots', slots=[slots[0]])
        self.assertEqual([x['id'] for x in s['frozen_batches']], [lots[1]['id']])
        self.assertFalse(s.get('frozen_withdrawals'))
        self.assertEqual(set(s['cryo_storage']['boxes'][0]['slots']), {'1'})

    def test_risk_window_clearance_and_recorded_thaw_medium(self):
        from cryo_storage import contamination_risk_map, stock_group_remaining_map
        base = dict(name='Example', at='2020-01-01', vials=4, storage_stage='unassigned',
                    subclone='C', passage='P3', resistance_tags=['Custom'])
        lots = {}
        variants = {
            'source': {}, 'peer': {}, 'edge': {'at': '2020-01-31'},
            'late': {'at': '2020-02-01'}, 'lower': {'at': '2020-01-02', 'passage': 'P2'},
            'different_tag': {'at': '2020-01-02', 'resistance_tags': ['Other']},
            'different_clone': {'subclone': 'other'}, 'explicit_wt': {'special_treatments': ['WT']},
        }
        for key, fields in variants.items():
            s = self.run_command('stock_create', **{**base, **fields})
            lots[key] = s['frozen_batches'][-1]['id']
        groups = stock_group_remaining_map(s)
        self.assertNotEqual(groups[lots['source']], groups[lots['explicit_wt']])
        s = self.run_command('discard_vials', lot_id=lots['source'], vials=1, at='2020-02-02', is_contamination=True)
        old = s['frozen_withdrawals'][-1]
        risks = contamination_risk_map(s)
        self.assertEqual({k for k, lid in lots.items() if risks[lid]['level'] != 'none'}, {'source', 'edge', 'peer'})
        with self.assertRaises(ValueError):
            self.run_command('clear_yellow_by_thaw', withdrawal_id=old['id'])
        recipe = {'base': 'User recipe', 'extra': 'yes',
                  'additives': [{'name': 'User entry', 'concentration': '0.070', 'unit': 'user units'}]}
        with self.assertRaises(ValueError):
            self.run_command('withdraw_vials', lot_id=lots['peer'], vials=1, mode='take', medium=recipe)
        self.assertEqual(self.db.state(), s)
        s = self.run_command('withdraw_vials', lot_id=lots['edge'], vials=1, mode='thaw', at='2020-02-03')
        with self.assertRaises(ValueError):
            self.run_command('clear_yellow_by_thaw', withdrawal_id=s['frozen_withdrawals'][-1]['id'])
        s = self.run_command('withdraw_vials', lot_id=lots['peer'], vials=1, mode='thaw', at='2020-02-03', medium=recipe)
        clean = s['frozen_withdrawals'][-1]
        self.assertEqual(clean['medium']['additives'], recipe['additives'])
        s = self.run_command('discard_vials', lot_id=lots['source'], vials=1, at='2020-02-03', is_contamination=True)
        self.assertEqual(contamination_risk_map(s)[lots['peer']]['level'], 'red')
        with self.assertRaises(ValueError):
            self.run_command('clear_yellow_by_thaw', withdrawal_id=clean['id'])
        self.run_command('mark_contamination', withdrawal_id=s['frozen_withdrawals'][-1]['id'], clear=True)
        s = self.run_command('clear_yellow_by_thaw', withdrawal_id=clean['id'], at='2020-02-04')
        self.assertTrue(all(info['level'] == 'none' for info in contamination_risk_map(s).values()))
        records = {w['id']: w for w in s['frozen_withdrawals']}
        self.assertEqual(records[old['id']]['contamination']['cleared_by_clean_thaw']['withdrawal_id'], clean['id'])
        self.assertEqual(records[clean['id']]['clean_verification']['clears_withdrawal_ids'], [old['id']])

    def test_slot_correction_retains_prior_withdrawal_history(self):
        s = self.run_command('setup_preset', device_name='Box', rows=1, cols=2)
        slots = [dict(box_id=s['cryo_storage']['boxes'][0]['id'], slot=k) for k in ['A1', 'A2']]
        s = self.run_command('stock_create', name='Sample', at='2020-01-01', vials=2, placements=slots)
        lid = s['frozen_batches'][0]['id']
        s = self.run_command('withdraw_vials', lot_id=lid, vials=1, mode='thaw', slots=[slots[0]])
        history = s['frozen_withdrawals']
        s = self.run_command('delete_slots', slots=[slots[1]])
        self.assertEqual(s['frozen_withdrawals'], history)
        self.assertEqual((s['frozen_batches'][0]['id'], s['frozen_batches'][0]['vials']), (lid, 1))
