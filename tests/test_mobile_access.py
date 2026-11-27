"""Test mobile access with synthetic adapter inventories and no network listener."""
import ipaddress
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import mobile_access as mobile


TAIL = '100.99.0.7'
LAN = '192.168.20.7'
SELF = {'connected': True, 'installed': True, 'ip': TAIL, 'dns_name': 'host.example.invalid'}
DOWN = {'connected': False, 'installed': True, 'ip': '', 'dns_name': ''}
INTERFACES = {TAIL: {'kind': 'tailscale', 'subnet': '100.64.0.0/10', 'interface': 'utun8', 'label': 'Tailscale'},
              LAN: {'kind': 'lan', 'subnet': '192.168.20.0/24', 'interface': 'en0', 'label': 'LAN'}}


class DiscoveryTests(unittest.TestCase):
    def test_mac_lan_and_tailscale_need_active_assigned_address(self):
        inventory = """en0: flags=8863<UP,BROADCAST,RUNNING>
        inet 192.168.20.7 netmask 0xffffff00 broadcast 192.168.20.255
        status: active
utun8: flags=8051<UP,POINTOPOINT,RUNNING>
        inet 100.99.0.7 --> 100.99.0.7 netmask 0xffffffff
utun9: flags=8051<UP,POINTOPOINT,RUNNING>
        inet 100.99.0.8 --> 100.99.0.8 netmask 0xffffffff
en2: flags=8863<UP,BROADCAST,RUNNING>
        inet 10.0.1.1 netmask 0xffffff00
        status: inactive
en3: flags=8863<UP,BROADCAST,RUNNING>
        inet 198.51.100.22 netmask 0xffff0000
lo0: flags=8049<UP,LOOPBACK,RUNNING>
        inet 127.0.0.1 netmask 0xff000000
"""
        with patch.object(sys, 'platform', 'darwin'), patch.object(mobile, '_network_command', return_value=inventory):
            rows = mobile.lan_interfaces(SELF)
            self.assertEqual(set(rows), {LAN, TAIL})
            self.assertEqual(rows[LAN]['subnet'], '192.168.20.0/24')
            self.assertEqual(rows[TAIL]['subnet'], '100.64.0.0/10')
            self.assertEqual(set(mobile.lan_interfaces(DOWN)), {LAN})

    @unittest.skipUnless(sys.platform == 'win32', 'Requires native Windows NetAdapter and NetTCPIP')
    def test_native_windows_adapter_discovery(self):
        # An isolated CI host may legitimately have no eligible private network.
        for name, address, prefix, physical in mobile._windows_adapters():
            self.assertIsInstance(name, str)
            self.assertIsInstance(physical, bool)
            self.assertEqual(ipaddress.IPv4Network((address, prefix), strict=False).version, 4)

    def test_windows_requires_physical_lan_or_verified_tailscale(self):
        rows = [('WLAN', LAN, 24, True), ('Tailscale', TAIL, 32, False),
                ('unknown tunnel', '100.99.0.8', 32, False), ('VPN', '10.0.2.2', 24, False),
                ('Ethernet', '203.0.113.8', 24, True), ('Ethernet 2', '10.0.1.2', 0, True)]
        output = json.dumps([dict(zip(('name', 'address', 'prefix', 'physical'), r)) for r in rows])
        with patch.object(sys, 'platform', 'win32'), patch.object(mobile, '_network_command', return_value=output) as run:
            found = mobile.lan_interfaces(SELF)
            self.assertEqual(set(found), {LAN, TAIL, '10.0.1.2'})
            self.assertEqual(found['10.0.1.2']['subnet'], '10.0.0.0/8')
            self.assertEqual(found[TAIL]['kind'], 'tailscale')
            self.assertIn('Get-NetIPAddress', run.call_args.args[0][-1])

    def test_tailscale_reports_running_self_without_peer_details(self):
        node = {'DNSName': 'host.example.invalid.', 'TailscaleIPs': ['fd7a:115c:a1e0::1', TAIL]}
        with patch.object(mobile, '_tailscale_binary', return_value='/example/tailscale'):
            with patch.object(mobile, '_network_command', return_value=json.dumps({'BackendState': 'Running', 'Self': node})):
                self.assertEqual(mobile.tailscale_status(), SELF)
            with patch.object(mobile, '_network_command', return_value=json.dumps({'BackendState': 'Stopped', 'Self': node})):
                self.assertEqual(mobile.tailscale_status(), DOWN)


class AccessTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        self.access = mobile.MobileAccess(self.folder, 8766)
        self.discover = self.mock('lan_interfaces', return_value=INTERFACES)
        self.mock('tailscale_status', return_value=SELF)
        self.mock('tls_identity')
        self.listener_factory = self.mock('MobileListener', side_effect=self.fake_listener)

    def mock(self, name, **opts):
        p = patch.object(mobile, name, **opts)
        self.addCleanup(p.stop)
        return p.start()

    @staticmethod
    def fake_listener(endpoint, handler):
        listener = MagicMock()
        listener.server_address = endpoint
        listener.server_port = endpoint[1]
        return listener

    def start(self, **opts):
        self.access.start(TAIL, object, **opts)
        return self.access.listener

    def test_default_never_listens_or_writes_to_disk(self):
        self.assertFalse(self.access.resume_autostart(object))
        self.discover.assert_not_called()
        self.listener_factory.assert_not_called()
        self.assertEqual(self.access.status()['code'], '')
        for addr in ('0.0.0.0', '127.0.0.1', '100.99.0.8', None):
            with self.assertRaises(ValueError):
                self.access.start(addr, object)
        self.assertFalse(self.access.directory.exists())

    def test_resume_same_address_and_kind_only_explicit_stop_cancels(self):
        original = self.start(auto_start=True)
        self.access.shutdown()
        original.shutdown.assert_called_once()
        self.assertTrue(self.access.status()['auto_start'])
        self.discover.return_value = {'100.99.1.1': INTERFACES[TAIL]}
        self.assertFalse(self.access.resume_autostart(object))
        self.discover.return_value = {TAIL: INTERFACES[LAN]}
        self.assertFalse(self.access.resume_autostart(object))
        self.discover.return_value = INTERFACES
        self.assertTrue(self.access.resume_autostart(object))
        self.assertEqual(self.access.listener.server_address[0], TAIL)
        self.access.stop()
        self.assertFalse(self.access.resume_autostart(object))
        self.assertFalse(self.access.status()['auto_start'])

    def test_failed_autostart_save_closes_uncommitted_listener(self):
        listener = self.fake_listener((TAIL, 8766), object)
        self.listener_factory.side_effect = lambda endpoint, handler: listener
        with patch.object(self.access, '_write_autostart', side_effect=OSError('write failure')):
            with self.assertRaises(OSError):
                self.start(auto_start=True)
        self.assertIsNone(self.access.listener)
        self.assertEqual(self.access.code, '')
        listener.shutdown.assert_called_once()
        listener.server_close.assert_called_once()

    def test_invalid_saved_config_never_enables_service(self):
        self.access.directory.mkdir()
        self.access.autostart_file.write_text(json.dumps({'enabled': 'false', 'kind': 'lan', 'address': LAN}))
        self.assertFalse(self.access.resume_autostart(object))
        self.discover.assert_not_called()

    def test_device_pair_persistence_expiration_and_revoke(self):
        original = self.start()
        code = self.access.code
        secret = self.access.pair(original, code, '测试手机')
        cookie = f'{mobile.COOKIE}={secret}'
        self.assertNotIn(secret, self.access.devices_file.read_text(encoding='utf-8'))
        with self.assertRaises(ValueError):
            self.access.pair(original, code, '第二台')
        device = self.access.status()['devices'][0]
        self.assertNotIn('digest', device)
        self.assertEqual(device['name'], '测试手机')
        self.access.stop()
        self.assertIsNone(self.access.credential(original, cookie))
        self.access = mobile.MobileAccess(self.folder, 8766)
        current = self.start()
        self.assertIsNone(self.access.credential(original, cookie))
        self.assertEqual(self.access.credential(current, cookie), secret)
        with patch.object(mobile.time, 'time', return_value=device['expires']):
            self.assertIsNone(self.access.credential(current, cookie))
        self.access.revoke(device['id'])
        self.assertIsNone(self.access.credential(current, cookie))

    def test_pair_code_expiry_and_attempt_limit(self):
        listener = self.start()
        code = self.access.code
        with patch.object(mobile.time, 'time', return_value=self.access.deadline):
            with self.assertRaises(ValueError):
                self.access.pair(listener, code, 'phone')
            self.assertEqual(self.access.status()['code'], '')
        self.access.new_code()
        code = self.access.code
        for _ in range(8):
            with self.assertRaises(ValueError):
                self.access.pair(listener, 'invalid', 'phone')
        with self.assertRaises(ValueError):
            self.access.pair(listener, code, 'phone')
        self.assertEqual(self.access.status()['code'], '')


if __name__ == '__main__':
    unittest.main()
