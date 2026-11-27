"""Synthetic inventory relations preserve explicit identity and provenance boundaries."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from cryo_storage import (
    contamination_risk_map, cross_category_related_batches, relation_tier,
    stock_group_remaining_map,
)


class CryoRelationTests(unittest.TestCase):
    def test_relation_tiers_require_matching_resistance_and_actual_overlap(self):
        anchor = dict(name='Example', at='2020-01-01T09:00', subclone='A',
                      special_treatments=['Edit X'], resistance_tags=['Drug A'])
        cases = [
            ('same group', {}, 'strong'),
            ('normalized tags', {'special_treatments': [' edit x ', 'EDIT X'],
                                 'resistance_tags': [' drug a ', 'DRUG A']}, 'strong'),
            ('another day', {'at': '2020-01-02'}, 'weak'),
            ('same-day different clone', {'subclone': 'B'}, 'weak'),
            ('different day and clone', {'subclone': 'B', 'at': '2020-01-02'}, 'weaker'),
            ('different resistance', {'resistance_tags': ['Drug B']}, 'weaker'),
            ('shared resistance only', {'special_treatments': ['Edit Y']}, 'weaker'),
            ('partial treatment overlap', {'special_treatments': ['Edit X', 'Edit Y']}, 'weaker'),
            ('no overlap', {'special_treatments': ['Edit Y'], 'resistance_tags': ['Drug B']}, None),
            ('other category', {'sample_category': 'protein'}, None),
            ('other name', {'name': 'Other'}, None),
        ]
        for label, changes, expected in cases:
            with self.subTest(label=label):
                other = {**anchor, **changes}
                self.assertEqual(relation_tier(anchor, other), expected)
                self.assertEqual(relation_tier(other, anchor), expected)

    def test_unknown_treatment_and_wt_do_not_create_false_relations(self):
        anchor = dict(name='Example', at='2020-01-01', subclone='A')
        self.assertEqual(relation_tier(anchor, dict(anchor)), 'strong')
        self.assertIsNone(relation_tier(anchor, {**anchor, 'special_treatments': ['WT']}))
        wt = {**anchor, 'special_treatments': ['WT']}
        self.assertEqual(relation_tier(wt, {**wt, 'subclone': 'B'}), 'weak')
        self.assertIsNone(relation_tier(wt, {**wt, 'subclone': 'B', 'at': '2020-01-02'}))
        self.assertIsNone(relation_tier({**anchor, 'donor': 'D1'}, {**anchor, 'source_subject': 'D2'}))
        self.assertIsNone(relation_tier({**anchor, 'donor': 'D1', 'source_subject': 'S1'},
                                        {**anchor, 'donor': 'D1', 'source_subject': 'S2'}))

    def test_stock_totals_separate_categories_subjects_and_unknown_treatment(self):
        base = dict(name='Example', at='2020-01-01', vials=2, resistance_tags=['A'])
        lots = [
            {**base, 'id': 'a'},
            {**base, 'id': 'b', 'resistance_tags': [' a ', 'A']},
            {**base, 'id': 'protein', 'sample_category': 'protein'},
            {**base, 'id': 'wt', 'special_treatments': ['WT']},
            {**base, 'id': 'subject', 'source_subject': 'Subject B'},
            {**base, 'id': 'specimen', 'specimen_type': 'Extract'},
        ]
        state = {'frozen_batches': lots, 'frozen_withdrawals': [{'lot_id': 'a', 'vials': 1}]}
        self.assertEqual(stock_group_remaining_map(state),
                         {'a': 3, 'b': 3, 'protein': 2, 'wt': 2, 'subject': 2, 'specimen': 2})

    def test_cross_category_panel_does_not_duplicate_cell_inventory(self):
        base = dict(name='Example', at='2020-01-01', vials=1)
        anchor = {**base, 'id': 'anchor', 'source_subject': 'D1',
                  'disease_model': 'Model', 'specimen_type': 'Extract'}
        lots = [anchor, {**anchor, 'id': 'cell-peer'},
                {**anchor, 'id': 'clinical', 'sample_category': 'clinical'},
                {**base, 'id': 'protein', 'sample_category': 'protein', 'specimen_type': 'Extract'},
                {**base, 'id': 'dna', 'sample_category': 'dna', 'specimen_type': 'Extract'},
                {**base, 'id': 'rna', 'sample_category': 'rna', 'disease_model': 'Model'}]
        state = {'frozen_batches': lots}
        groups = cross_category_related_batches(state, 'anchor')
        self.assertEqual([x['batch']['id'] for x in groups['same_subject']], ['clinical'])
        self.assertEqual([x['batch']['id'] for x in groups['same_model']], ['rna'])
        self.assertEqual(groups['same_specimen'], [])
        groups = cross_category_related_batches(state, 'protein')
        self.assertEqual([x['batch']['id'] for x in groups['same_specimen']], ['clinical', 'dna'])

    def test_contamination_strong_links_do_not_cross_resistance_groups(self):
        base = dict(name='Example', at='2020-01-01', vials=2, special_treatments=['Edit X'],
                    resistance_tags=['A'], subclone='Clone A')
        lots = [{**base, 'id': 'source'}, {**base, 'id': 'peer'},
                {**base, 'id': 'different-resistance', 'resistance_tags': ['B']},
                {**base, 'id': 'different-clone', 'subclone': 'Clone B'},
                {**base, 'id': 'protein', 'sample_category': 'protein'}]
        state = {'frozen_batches': lots, 'frozen_withdrawals': [
            {'id': 'event', 'lot_id': 'source', 'vials': 1, 'at': '2020-01-02',
             'contamination': {'at': '2020-01-02'}}]}
        risks = contamination_risk_map(state)
        self.assertEqual({lid for lid, risk in risks.items() if risk['level'] != 'none'}, {'source', 'peer'})


if __name__ == '__main__':
    unittest.main()
