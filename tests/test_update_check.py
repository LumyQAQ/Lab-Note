"""No live installs, GitHub, or user data needed for release checks and upgrades."""
from contextlib import closing
import hashlib
from http.client import IncompleteRead
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from threading import Thread
from urllib.request import build_opener, ProxyHandler
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
import mac_update
import update_check


def release(version, windows=False):
    return {'tag_name': 'v' + version, 'prerelease': '-' in version,
            'body': '## 更新\n- **改进**检索\n- [说明](https://example.org)',
            'assets': [{'name': f'Lab-Note-{version}-Windows-x64.zip'}] if windows else []}


class VersionChecks(unittest.TestCase):
    def test_stable_reporting(self):
        self.assertEqual(update_check.read_app_version(), (ROOT / 'VERSION').read_text().strip())
        result = update_check.check_for_updates('1.5.0', windows=False, fetcher=lambda _: release('1.10.0'))
        self.assertTrue(result['has_update'])
        self.assertEqual(result['notes'], '改进检索；说明')
        self.assertEqual(result['release_url'], update_check.RELEASES_URL + '/tag/v1.10.0')
        for tag in ('1.5.0', '1.4.99'):
            self.assertFalse(update_check.check_for_updates('1.5.0', windows=False,
                             fetcher=lambda _: release(tag))['has_update'])
        for invalid in ('1.5.0-preview.2', 'bad'):
            self.assertEqual(update_check.check_for_updates('1.5.0', windows=False,
                             fetcher=lambda _: release(invalid))['status'], 'offline')

    def test_windows_filters_assets_and_drafts_and_compares_preview_numbers(self):
        items = [release('1.7.0'), dict(release('1.8.0-preview.1', True), draft=True),
                 release('1.5.0-preview.10', True), release('1.5.0-preview.3', True)]
        result = update_check.check_for_updates('1.5.0-preview.9', windows=True, fetcher=lambda _: items)
        self.assertTrue(result['has_update'])
        self.assertEqual(result['latest_version'], '1.5.0-preview.10')
        self.assertEqual(update_check.check_for_updates('1.5.0-preview.10', windows=True,
                         fetcher=lambda _: items)['has_update'], False)

    def test_public_http_version_and_offline_update_route(self):
        from server import make_server
        with tempfile.TemporaryDirectory() as tmp, make_server(tmp, 0) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                opener = build_opener(ProxyHandler({}))

                def get(path):
                    with opener.open(f'http://127.0.0.1:{server.server_port}{path}', timeout=5) as response:
                        return json.load(response)

                self.assertEqual(get('/api/version')['version'], update_check.read_app_version())
                self.assertEqual(get('/api/state')['app_version'], update_check.read_app_version())
                with patch.object(update_check, '_fetch', side_effect=TimeoutError('offline fixture')):
                    status = get('/api/update-check?force=1')
                self.assertEqual(status['status'], 'offline')
                self.assertFalse(status['has_update'])
                self.assertEqual(get('/api/health')['install_dir'], str(ROOT))
            finally:
                server.shutdown()
                thread.join()
                update_check.reset_cache()

    def test_offline_cache_force_and_channel_separation(self):
        update_check.reset_cache()
        with patch.object(update_check, '_fetch', side_effect=[release('1.6.0'), IncompleteRead(b''), []]) as fetch:
            def check(windows=False, force=False):
                return update_check.check_for_updates('1.5.0', windows=windows, force=force)
            self.assertEqual(check(), check())
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(check(force=True)['status'], 'offline')
            self.assertEqual(check(windows=True)['status'], 'offline')
            self.assertEqual(fetch.call_count, 3)
        update_check.reset_cache()


@unittest.skipUnless(sys.platform == 'darwin', 'macOS ZIP updater')
class MacUpdate(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.tmp = Path(directory.name).resolve()
        self.root = self.tmp / 'installed'
        self.candidate = self.tmp / 'replacement'
        for path, version in ((self.root, '1.5.0'), (self.candidate, '1.6.0')):
            path.mkdir()
            (path / 'VERSION').write_text(version)
        self.data = self.tmp / 'isolated-test-data'
        self.data.mkdir()
        with closing(sqlite3.connect(self.data / 'culture.sqlite3')) as connection:
            connection.execute('CREATE TABLE sentinel(value)')
            connection.execute('INSERT INTO sentinel VALUES (42)')
            connection.commit()

    def test_signed_release_verified_with_installed_key(self):
        keys = self.tmp / 'test-key'
        subprocess.run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(keys)], check=True)
        signers = self.root / mac_update.SIGNERS
        signers.parent.mkdir(parents=True)
        signers.write_text('LumyQAQ ' + keys.with_suffix('.pub').read_text())
        archive = self.tmp / 'lab-note-v1.6.0.zip'
        with zipfile.ZipFile(archive, 'w') as package:
            for name in (str(mac_update.SIGNERS), mac_update.UPDATER, '启动实验日记.command', 'app/launch.py',
                         'app/server.py', 'app/mac_update.py'):
                package.writestr('Lab-Note/' + name, 'test')
            package.writestr('Lab-Note/VERSION', '1.6.0')
        subprocess.run(['/usr/bin/ssh-keygen', '-Y', 'sign', '-n', 'lab-note-release', '-f', str(keys),
                        str(archive)], check=True, capture_output=True)

        def offline_download(url, target, _limit):
            self.assertEqual(url, update_check.RELEASES_URL + '/download/v1.6.0/' + target.name)
            shutil.copyfile(self.tmp / target.name, target)

        with patch.object(mac_update, 'download', side_effect=offline_download):
            staged = self.tmp / 'stage'
            staged.mkdir()
            with mac_update.install_lock(self.root):
                extracted = mac_update.stage_release(self.root, 'v1.6.0', staged)
            self.assertEqual(update_check.read_app_version(extracted), '1.6.0')
            self.assertTrue((extracted / mac_update.UPDATER).stat().st_mode & 0o100)
            with archive.open('ab') as target:
                target.write(b'tampered')
            staged = self.tmp / 'untrusted'
            staged.mkdir()
            with self.assertRaises(subprocess.CalledProcessError):
                mac_update.stage_release(self.root, 'v1.6.0', staged)
            self.assertFalse((staged / 'Lab-Note').exists())
            self.assertEqual(update_check.read_app_version(self.root), '1.5.0')

    def test_stopped_upgrade_preserves_data_and_retains_old_install(self):
        with patch.object(mac_update.launch, 'existing', return_value=(None, None)):
            mac_update.install(self.root, self.candidate, self.data, None)
        self.assertEqual(update_check.read_app_version(self.root), '1.6.0')
        self.assertEqual(update_check.read_app_version(self.candidate), '1.5.0')
        backup, = (self.data / 'backups').glob('*.sqlite3')
        self.assertEqual(backup.with_suffix('.sha256').read_text().split()[0],
                         hashlib.sha256(backup.read_bytes()).hexdigest())
        with closing(sqlite3.connect(backup)) as saved:
            self.assertEqual(saved.execute('SELECT value FROM sentinel').fetchone(), (42,))

    def test_restart_failure_rolls_back_program_and_database(self):
        def start(data, port):
            self.assertEqual(port, 49152)
            if update_check.read_app_version(self.root) == '1.6.0':
                with closing(sqlite3.connect(data / 'culture.sqlite3')) as db:
                    db.execute('DELETE FROM sentinel')
                    db.commit()
                raise SystemExit('simulated start failure')
            return port
        with patch.object(mac_update.launch, 'existing', return_value=(49152, {'install_dir': str(self.root)})), \
                patch.object(mac_update.launch, 'stop') as stop, \
                patch.object(mac_update.launch, 'running_server', return_value=None), \
                patch.object(mac_update.launch, 'start', side_effect=start) as launch:
            with self.assertRaisesRegex(SystemExit, 'simulated start failure'):
                mac_update.install(self.root, self.candidate, self.data, None)
            stop.assert_called_once()
            self.assertEqual(launch.call_count, 2)
        self.assertEqual(update_check.read_app_version(self.root), '1.5.0')
        with closing(sqlite3.connect(self.data / 'culture.sqlite3')) as db:
            self.assertEqual(db.execute('SELECT value FROM sentinel').fetchone(), (42,))

    def test_other_install_and_nested_data_are_refused_before_stop(self):
        with patch.object(mac_update.launch, 'existing', return_value=(49152, {})), \
                patch.object(mac_update.launch, 'stop') as stop:
            for data in (self.data, self.root / 'user-data'):
                with self.assertRaises(ValueError):
                    mac_update.install(self.root, self.candidate, data, None)
            stop.assert_not_called()
        self.assertEqual(update_check.read_app_version(self.root), '1.5.0')


if __name__ == '__main__':
    unittest.main()
