"""Layout-only experiment plates do not create culture-review work."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from store import Store, current_time


class WorkdayLayoutTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.store = Store(folder.name)

    def command(self, action, **payload):
        return self.store.mutate(action, payload, self.store.state()['revision'])

    def test_layouts_excluded_from_review_counts_without_marking_checked(self):
        for kind, layout in [('Transwell 6孔板', 'transwell'), ('低吸附U底96孔板', 'organoid')]:
            cid = self.command('create', name='Synthetic layout', type=kind)['containers'][-1]['id']
            self.command('plate_contents', id=cid, wells=['A1'], kind=layout)
        report = self.store.workday()
        self.assertEqual(report['counts']['active'], 2)
        self.assertEqual(report['counts']['pending'], 0)
        self.assertEqual(report['counts']['checked'], 0)
        self.assertTrue(all(c['layout_only'] and not c['checked'] for c in report['containers']))

    def test_confirm_and_snapshot_skip_layout_but_preserve_real_review(self):
        plate = self.command('create', name='Synthetic layout', type='Transwell 6孔板')['containers'][-1]['id']
        self.command('plate_contents', id=plate, wells=['A1'], kind='transwell')
        state = self.command('confirm')
        self.assertEqual(state['containers'][0]['checked_date'], '')
        self.assertTrue(self.store.snapshot()['verified'])
        cid = self.command('create', name='Synthetic culture', type='T25')['containers'][-1]['id']
        self.command('wells', id=cid, wells=list(self.store.state()['containers'][-1]['wells']), patch={'cell':'Synthetic cell',
                     'day0':current_time().date().isoformat(), 'kind':'细胞系', 'anchor':'复苏'})
        self.assertFalse(self.store.snapshot()['verified'])
        state = self.command('confirm')
        self.assertEqual(state['containers'][0]['checked_date'], '')
        self.assertEqual(state['containers'][1]['checked_date'], current_time().date().isoformat())
        self.assertTrue(self.store.snapshot()['verified'])

    def test_empty_and_actual_cultures_still_require_review(self):
        plate = self.command('create', name='Synthetic mixed', type='Transwell 6孔板')['containers'][-1]['id']
        self.command('plate_contents', id=plate, wells=['A1'], kind='transwell')
        self.command('wells', id=plate, wells=['A2'], patch={'cell':'Synthetic cell', 'day0':current_time().date().isoformat(), 'kind':'细胞系', 'anchor':'复苏'})
        self.command('create', name='Synthetic blank', type='T25')
        report = self.store.workday()
        self.assertEqual(report['counts']['pending'], 2)
        self.assertFalse(any(c['layout_only'] for c in report['containers']))
        self.command('check', id=plate)
        report = self.store.workday()
        self.assertEqual(report['counts']['pending'], 1)
        self.assertEqual(report['counts']['checked'], 1)
        row = next(c for c in report['containers'] if c['id'] == plate)
        self.assertTrue(row['checked'])
        self.assertFalse(row['layout_only'])


if __name__ == '__main__':
    unittest.main()
