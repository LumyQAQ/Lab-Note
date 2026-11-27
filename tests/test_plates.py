"""Public plate simulation and plate-derived notebook drafts use synthetic data only."""
import copy
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from store import Store, current_time


class PlateTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.store = Store(folder.name)

    def cmd(self, action, **payload):
        return self.store.mutate(action, payload, self.store.state()['revision'])

    def plate(self, kind='Transwell 6孔板'):
        return self.cmd('create', name='Synthetic plate', type=kind)['containers'][-1]['id']

    def test_transwell_sizes_and_low_attachment(self):
        for kind, count in [('Transwell 6孔板', 6), ('Transwell 12孔板', 12),
                            ('Transwell 24孔板', 24), ('低吸附U底96孔板', 96)]:
            self.plate(kind)
            self.assertEqual(len(self.store.state()['containers'][-1]['wells']), count)

    def test_transwell_actual_layout_prefills_only_observed_values(self):
        cid = self.plate()
        state = self.cmd('plate_contents', id=cid, wells=['A1'], kind='transwell',
                         upper_cell='Synthetic upper', upper_cells_per_well='1200',
                         upper_volume_ul='100', lower_medium='Synthetic condition',
                         lower_volume_ul='600', pore_size_um='0.4', group='Synthetic group')
        containers = copy.deepcopy(state['containers'])
        state = self.cmd('plate_experiment_today', id=cid, kind='transwell', date=current_time().date().isoformat())
        record = state['lab_records'][-1]
        self.assertEqual(state['containers'], containers)
        self.assertEqual(record['status'], 'draft')
        self.assertEqual(record['plate_context']['container_id'], cid)
        self.assertEqual(record['data']['pore_size'], '0.4')
        self.assertEqual(record['data']['seeding_protocol'], '')
        self.assertEqual(record['tables']['chamber_groups'][0]['upper_volume_ul'], '100')
        self.assertEqual(record['tables']['chamber_groups'][0]['upper_cell'], 'Synthetic upper')
        self.assertEqual(len(record['tables']['chamber_groups']), 1)
        repeated = self.cmd('plate_experiment_today', id=cid, kind='transwell', date=current_time().date().isoformat())
        self.assertEqual(len(repeated['lab_records']), 1)
        edited = self.cmd('lab_record_save', **{key:copy.deepcopy(record[key]) for key in
                          ('id','type','variant','title','record_date','status','data','tables')})
        self.assertEqual(edited['lab_records'][-1]['plate_context'], record['plate_context'])

    def test_organoid_coculture_from_layout(self):
        cid = self.plate('低吸附U底96孔板')
        self.cmd('plate_contents', id=cid, wells=['A1','A2'], kind='organoid',
                 organoid_name='Synthetic model', matrix_type='Synthetic matrix',
                 dome_volume_ul='20', dome_count='2', effector_cell='Synthetic effector',
                 effector_cells_per_well='1000', et_ratio='2:1', final_volume_ul='200')
        state = self.cmd('plate_experiment_today', id=cid, kind='organoid/coculture', date=current_time().date().isoformat())
        record = state['lab_records'][-1]
        self.assertEqual(len(record['tables']['plating_groups']), 2)
        self.assertEqual(record['tables']['plating_groups'][0]['effector_count'], '1000')
        self.assertEqual(record['data']['dissociation_embedding_steps'], '')
        self.assertEqual(record['data']['organoid_source'], 'Synthetic model')

    def test_layout_validation_and_resize_protects_saved_wells(self):
        cid = self.plate('Transwell 24孔板')
        self.cmd('plate_contents', id=cid, wells=['D6'], kind='transwell', upper_cell='Synthetic upper')
        before = self.store.state()
        with self.assertRaises(ValueError):
            self.cmd('rename', id=cid, type='Transwell 6孔板', name='Synthetic plate', location='')
        self.assertEqual(self.store.state(), before)
        with self.assertRaises(ValueError):
            self.cmd('plate_contents', id=cid, wells=['A1'], kind='transwell', upper_volume_ul='-1')
        self.assertEqual(self.store.state(), before)


if __name__ == '__main__':
    unittest.main()
