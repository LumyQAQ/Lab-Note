"""Verify real, temporary local identities without changing network or trust settings."""
import ipaddress
from pathlib import Path
import socket
import ssl
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
from mobile_tls import tls_identity


def handshake(server_context, client_context, hostname):
    server_socket, client_socket = socket.socketpair()
    server_socket.settimeout(5)
    client_socket.settimeout(5)

    def serve():
        try:
            with server_socket, server_context.wrap_socket(server_socket, server_side=True) as conn:
                conn.recv(1)
        except ssl.SSLError:
            pass  # The client rejects deliberately invalid identities in negative cases.

    worker = threading.Thread(target=serve)
    worker.start()
    try:
        with client_socket, client_context.wrap_socket(client_socket, server_hostname=hostname) as conn:
            conn.sendall(b'x')
            return conn.getpeercert()
    finally:
        worker.join(6)


class MobileTLSTests(unittest.TestCase):
    def test_trusted_ip_san_and_stable_constrained_root(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / '临时证书 with spaces'
            authority = directory / 'authority' / 'ca.pem'
            lan_ip, tail_ip = '192.168.178.5', '100.127.255.254'
            lan = tls_identity(directory, lan_ip)
            original = authority.read_bytes()
            der = ssl.PEM_cert_to_DER_cert(original.decode('ascii'))
            # DER for critical id-ce-nameConstraints, followed by its four IPv4 subtrees.
            self.assertIn(bytes.fromhex('0603551d1e0101ff'), der)
            for cidr in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'):
                net = ipaddress.ip_network(cidr)
                self.assertIn(b'\x87\x08' + net.network_address.packed + net.netmask.packed, der)
            client = ssl.create_default_context(cafile=str(authority))
            self.assertEqual(handshake(lan, client, lan_ip)['subjectAltName'], (('IP Address', lan_ip),))
            tail = tls_identity(directory, tail_ip)
            self.assertEqual(authority.read_bytes(), original)
            self.assertEqual(handshake(tail, client, tail_ip)['subjectAltName'], (('IP Address', tail_ip),))
            with self.assertRaises(ssl.SSLCertVerificationError):
                handshake(tail, client, lan_ip)
            with self.assertRaises(ssl.SSLCertVerificationError):
                handshake(tail, ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT), tail_ip)
            self.assertEqual(list(directory.iterdir()), [authority.parent])
            self.assertNotIn(b'PRIVATE KEY', original)
            self.assertFalse(list(directory.rglob('leaf*')))

    def test_public_and_non_ipv4_names_rejected_before_key_creation(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'mobile'
            for address in ('8.8.8.8', '100.63.255.255', '100.128.0.0', '127.0.0.1', 'localhost', '::1'):
                with self.subTest(address=address), self.assertRaises(ValueError):
                    tls_identity(directory, address)
            self.assertFalse(directory.exists())


if __name__ == '__main__':
    unittest.main()
