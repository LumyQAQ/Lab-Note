"""Backup settings and archives use isolated synthetic data directories."""
import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from store import Store


class BackupDirTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.store = Store(self.root / 'data')
        self.custom = self.root / 'custom' / '备份'

    def test_blank_defaults_and_per_data_directory_persistence(self):
        info = self.store.backup_dir_info()
        self.assertFalse(info['is_custom_backup_dir'])
        self.assertIsNone(info['last_backup'])
        self.assertFalse(self.store._backup_config_file.exists())
        self.store.set_backup_dir(str(self.custom))
        self.assertEqual(Store(self.store.directory).backup_dir(), self.custom)
        self.assertFalse(Store(self.root / 'other').is_custom_backup_dir())
        self.assertEqual(self.store.state()['revision'], 0)

    def test_switch_backup_download_lookup_and_reset(self):
        first = self.store.backup()
        initial_marker = self.store.backup_status()['backup_marker']
        info = self.store.set_backup_dir(str(self.custom))
        self.assertTrue(info['backup_dir_exists'])
        self.assertIsNone(info['last_backup'])
        self.assertNotEqual(info['backup_marker'], initial_marker)
        second = self.store.backup()
        self.assertEqual(second.parent, self.custom)
        self.assertEqual(self.store.resolve_backup_file(first.name), first)
        self.assertEqual(self.store.resolve_backup_file(second.name), second)
        self.assertEqual(self.store.backup_status()['last_backup'], second.name)
        digest = hashlib.sha256(second.read_bytes()).hexdigest()
        self.assertEqual(second.with_suffix('.sha256').read_text().split()[0], digest)
        with sqlite3.connect(second) as conn:
            self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        reset = self.store.set_backup_dir(None)
        self.assertFalse(reset['is_custom_backup_dir'])
        self.assertEqual(reset['last_backup'], first.name)
        self.assertTrue(second.is_file())

    def test_template_sidecar_is_immutable_and_failure_cleans_partial_backup(self):
        first = self.store.backup()
        sidecar = first.with_suffix('.templates.zip')
        before = sidecar.read_bytes()
        with zipfile.ZipFile(sidecar) as archive:
            self.assertEqual(archive.namelist(), ['word_templates/registry.json'])
        with patch('word_templates.snapshot_templates', side_effect=ValueError('broken template')):
            with self.assertRaises(ValueError):
                self.store.backup()
        self.assertEqual(sidecar.read_bytes(), before)
        self.assertEqual(len(list(first.parent.glob('*.sqlite3'))), 1)
        self.assertEqual(list(first.parent.glob('*.tmp')), [])

    def test_invalid_settings_preserve_active_destination(self):
        self.store.set_backup_dir(str(self.custom))
        file = self.root / 'file'
        file.write_text('x')
        for value in (123, 'relative/path', '/bad\npath', str(file), str(self.store.db)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.store.set_backup_dir(value)
            self.assertEqual(self.store.backup_dir(), self.custom)

    def test_failed_write_probe_preserves_settings(self):
        self.store.set_backup_dir(str(self.custom))
        original = self.store._backup_config_file.read_bytes()
        with patch('store.tempfile.mkstemp', side_effect=PermissionError('denied')):
            with self.assertRaises(ValueError):
                self.store.set_backup_dir(str(self.root / 'blocked'))
        self.assertEqual(self.store._backup_config_file.read_bytes(), original)

    def test_corrupt_or_invalid_config_falls_back_to_default(self):
        for value in ('{', '[]', json.dumps({'backup_dir': 'relative'}), json.dumps({'backup_dir': '/bad\u0000path'})):
            self.store._backup_config_file.write_text(value)
            self.assertEqual(self.store.backup_dir(), self.store.default_backup_dir())

    def test_snapshot_backup_uses_destination_without_duplicate_default_receipt(self):
        snap = self.store.snapshot()
        default_files = list(self.store.default_backup_dir().glob('*.sqlite3'))
        self.store.set_backup_dir(str(self.custom))
        self.store.ensure_snapshot_backup(snap['id'])
        self.assertEqual(list(self.custom.glob('*.sqlite3')), [])
        default_files[0].unlink()
        self.store.ensure_snapshot_backup(snap['id'])
        self.assertEqual(len(list(self.custom.glob('*.sqlite3'))), 1)

    def test_lookup_rejects_traversal_and_symlink_escape(self):
        self.store.backup()
        external = self.root / 'secret.sqlite3'
        external.write_text('private')
        for name in ('../secret.sqlite3', str(external), '..\\secret.sqlite3'):
            self.assertIsNone(self.store.resolve_backup_file(name))
        link = self.store.default_backup_dir() / 'escape.sqlite3'
        try:
            link.symlink_to(external)
        except OSError:
            self.skipTest('symlinks unavailable')
        self.assertIsNone(self.store.resolve_backup_file(link.name))

    def test_missing_custom_directory_is_recreated_for_backup(self):
        self.store.set_backup_dir(str(self.custom))
        self.custom.rmdir()
        self.assertFalse(self.store.backup_dir_info()['backup_dir_exists'])
        self.assertEqual(self.store.backup().parent, self.custom)


if __name__ == '__main__':
    unittest.main()
