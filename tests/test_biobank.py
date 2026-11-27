"""Blank public biobank schema, storage reminders and explicit subject matching."""
import copy
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from store import Store
from cryo_storage import (SAMPLE_CATEGORIES, cross_category_related_batches,
    evaluate_minus80_viability, normalize_optional_fields, contamination_risk_map,
    render_box_print_html, stock_group_remaining_map)


class BiobankTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Store(self.temp.name)
        self.state = self.db.state()

    def command(self, action, **payload):
        self.state = self.db.mutate('cryo_' + action, payload, self.state['revision'])
        return self.state

    def stock(self, **extra):
        self.command('stock_create', **dict(name='Synthetic sample', at='2020-01-01',
            vials=1, storage_stage='unassigned', **extra))
        return self.state['frozen_batches'][-1]

    def test_initial_blank_and_all_categories_round_trip(self):
        self.assertFalse(self.state.get('frozen_batches'))
        self.assertFalse(self.state.get('cryo_storage', {}).get('devices'))
        self.assertEqual(len(SAMPLE_CATEGORIES), 9)
        for category in SAMPLE_CATEGORIES:
            lot = self.stock(sample_category=category, specimen_type='User subtype',
                source_subject='Subject-test', disease_model='User model',
                sample_meta={'concentration': '12 test units', 'volume': '3 μL'})
            self.assertEqual(lot['sample_category'], category)
            self.assertEqual(lot['source_subject'], 'Subject-test')
            self.assertEqual(lot['sample_meta']['concentration'], '12 test units')
            self.assertEqual(lot['sources'], [])
            self.assertEqual(lot['special_treatments'], [])
        self.assertEqual(Store(self.temp.name).state()['frozen_batches'], self.state['frozen_batches'])

    def test_old_defaults_and_partial_updates(self):
        fields = normalize_optional_fields({}, existing={'name': 'Old', 'special_treatments': []})
        self.assertEqual(fields['sample_category'], 'cell')
        self.assertEqual(fields['sample_meta'], {})
        lot = self.stock(sample_category='protein', source_subject='Subject-test',
                         sample_meta={'concentration': '12 units'})
        self.command('batch_update', lot_id=lot['id'], notes='Changed note')
        updated = self.state['frozen_batches'][-1]
        self.assertEqual(updated['sample_category'], 'protein')
        self.assertEqual(updated['source_subject'], 'Subject-test')
        self.assertEqual(updated['sample_meta'], {'concentration': '12 units'})
        self.command('batch_update', lot_id=lot['id'], source_subject='', sample_meta={})
        self.assertEqual(self.state['frozen_batches'][-1]['sample_meta'], {})

    def test_invalid_categories_and_meta_are_atomic(self):
        baseline = copy.deepcopy(self.state)
        for bad in ({'sample_category': 'unknown'}, {'sample_category': []},
                    {'sample_meta': []}, {'sample_meta': {'unlisted': 'value'}}):
            with self.assertRaises(ValueError):
                self.stock(**bad)
            self.assertEqual(self.db.state(), baseline)

    def test_device_types_and_print_escaping(self):
        for kind in ('minus20', 'fridge4'):
            self.command('setup_preset', device_name='Device ' + kind,
                         device_kind=kind, box_count=1, rows=2, cols=2)
            self.assertEqual(self.state['cryo_storage']['devices'][-1]['kind'], kind)
        box = self.state['cryo_storage']['boxes'][-1]
        self.stock(sample_category='dna', source_subject='<Subject-test>',
                   sample_meta={'concentration': '<12 units>'},
                   placements=[{'box_id': box['id'], 'slot': 'A1'}])
        sheet = render_box_print_html(self.state, box['id'])
        self.assertIn('DNA', sheet)
        self.assertIn('&lt;Subject-test&gt;', sheet)
        self.assertNotIn('<Subject-test>', sheet)
        self.assertIn('&lt;12 units&gt;', sheet)

    def test_cross_category_linkage_requires_user_fields(self):
        cell = self.stock(sample_category='cell', source_subject='  Subject-test  ')
        protein = self.stock(sample_category='protein', source_subject='subject-test')
        unrelated = self.stock(sample_category='dna', source_subject='Different')
        blank = self.stock(sample_category='rna')
        groups = cross_category_related_batches(self.state, cell['id'])
        self.assertEqual([x['batch']['id'] for x in groups['same_subject']], [protein['id']])
        self.assertFalse(cross_category_related_batches(self.state, blank['id'])['same_subject'])
        totals = stock_group_remaining_map(self.state)
        self.assertEqual([totals[x['id']] for x in (cell, protein, unrelated, blank)], [1, 1, 1, 1])

    def test_minus80_stages_exclude_noncell_depleted_and_other_devices(self):
        self.command('setup_preset', device_name='Review freezer', device_kind='minus80',
                     box_count=1, rows=2, cols=3)
        box = self.state['cryo_storage']['boxes'][0]
        line = self.stock(placements=[{'box_id': box['id'], 'slot': 'A1'}])
        primary = self.stock(cell_kind='原代', placements=[{'box_id': box['id'], 'slot': 'A2'}])
        protein = self.stock(sample_category='protein', placements=[{'box_id': box['id'], 'slot': 'A3'}])
        self.assertEqual(evaluate_minus80_viability(self.state, '2020-03-30'), {})
        alerts = evaluate_minus80_viability(self.state, '2020-03-31')
        self.assertEqual(set(alerts), {primary['id']})
        self.assertEqual(alerts[primary['id']]['level'], 'caution')
        alerts = evaluate_minus80_viability(self.state, '2020-06-29')
        self.assertEqual(alerts[line['id']]['level'], 'caution')
        self.assertEqual(alerts[primary['id']]['level'], 'warning')
        self.assertNotIn(protein['id'], alerts)
        self.assertIn('不代表实际', alerts[line['id']]['reason'])
        self.assertEqual(evaluate_minus80_viability(self.state, '2020-12-31')[line['id']]['level'], 'warning')
        self.command('withdraw_vials', lot_id=primary['id'], vials=1,
                     slots=[{'box_id': box['id'], 'slot': 'A2'}], mode='take')
        self.assertNotIn(primary['id'], evaluate_minus80_viability(self.state, '2020-12-31'))
        self.state['cryo_storage']['devices'][0]['kind'] = 'ln2'
        self.assertFalse(evaluate_minus80_viability(self.state, '2020-12-31'))

    def test_contamination_does_not_cross_sample_categories(self):
        cell = self.stock(sample_category='cell')
        protein = self.stock(sample_category='protein')
        self.state['frozen_withdrawals'] = [{'id': 'event', 'lot_id': cell['id'],
            'vials': 0, 'contamination': {'at': '2020-01-02'}}]
        risk = contamination_risk_map(self.state)
        self.assertEqual(risk[cell['id']]['level'], 'yellow')
        self.assertEqual(risk[protein['id']]['level'], 'none')


if __name__ == '__main__':
    unittest.main()
