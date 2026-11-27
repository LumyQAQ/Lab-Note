"""Desktop-managed, paired HTTPS access to this notebook's local data directory."""
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from http.cookies import CookieError, SimpleCookie
from http.server import ThreadingHTTPServer

from mobile_tls import tls_identity


COOKIE = '__Host-lab-note-device'
DEVICE_LIFETIME = 90 * 86400
PRIVATE_NETWORKS = tuple(ipaddress.IPv4Network(cidr) for cidr in
                         ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
TAILSCALE_NETWORK = ipaddress.IPv4Network('100.64.0.0/10')


def _network_command(args, timeout):
    return subprocess.run(args, capture_output=True, encoding='utf-8', errors='replace',
                          check=True, timeout=timeout,
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout


def _tailscale_binary():
    if sys.platform == 'win32':
        candidates = [Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Tailscale/tailscale.exe']
    else:
        candidates = [Path(p) for p in ('/Applications/Tailscale.app/Contents/MacOS/Tailscale',
                                        '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale')]
    return next((str(p) for p in candidates if p.is_file()), None)


def tailscale_status():
    binary = _tailscale_binary()
    info = {'installed': bool(binary), 'connected': False, 'ip': '', 'dns_name': ''}
    if binary:
        try:
            data = json.loads(_network_command([binary, 'status', '--json'], timeout=3))
            node = data.get('Self') or {}
            addresses = (ipaddress.ip_address(s) for s in node.get('TailscaleIPs', []))
            address = next((a for a in addresses if a in TAILSCALE_NETWORK), None)
            if data.get('BackendState') == 'Running' and address:
                info.update(connected=True, ip=str(address), dns_name=str(node.get('DNSName') or '').rstrip('.'))
        except (OSError, subprocess.SubprocessError, ValueError, TypeError, AttributeError):
            pass
    return info


def _mac_adapters():
    output = _network_command(['/sbin/ifconfig', '-a'], timeout=4)
    for section in re.split(r'\n(?=[^\s])', output):
        name = section.partition(':')[0]
        header = section.partition('\n')[0]
        if not re.search(r'[<,]UP[,>]', header) or 'status: inactive' in section:
            continue
        physical = bool(re.fullmatch(r'(?:en|bridge)\d+', name))
        if not physical and not re.fullmatch(r'utun\d+', name):
            continue
        for address, mask in re.findall(r'\binet ([\d.]+)(?:\s+-->\s+[\d.]+)?\s+netmask (0x[\da-fA-F]+)', section):
            yield name, address, str(ipaddress.IPv4Address(int(mask, 16))), physical


def _windows_adapters():
    # NetTCPIP and NetAdapter return structured properties independently of the display language.
    shell = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    script = """
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$adapters = @{}
Get-NetAdapter -IncludeHidden -ErrorAction Stop | Where-Object Status -eq 'Up' | ForEach-Object {
    $adapters[[int]$_.ifIndex] = $_
}
$addresses = Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction Stop
$rows = @(foreach ($ip in $addresses) {
    $nic = $adapters[[int]$ip.InterfaceIndex]
    if ($null -ne $nic) {
        [pscustomobject]@{name=$nic.Name;address=$ip.IPAddress;prefix=$ip.PrefixLength;physical=[bool]$nic.HardwareInterface}
    }
})
ConvertTo-Json -Compress -InputObject $rows
"""
    output = _network_command([str(shell), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], timeout=10)
    for row in json.loads(output.lstrip('\ufeff')):
        yield row['name'], row['address'], row['prefix'], row['physical'] is True


def lan_interfaces(tailscale=None):
    """Offer only assigned addresses on physical LANs or the running Tailscale node."""
    if tailscale is None:
        tailscale = tailscale_status()
    if sys.platform not in ('darwin', 'win32'):
        return {}
    adapters = _windows_adapters if sys.platform == 'win32' else _mac_adapters
    found = {}
    try:
        for name, address, mask, physical in adapters():
            ip = ipaddress.IPv4Address(address)
            if ip in TAILSCALE_NETWORK and tailscale['connected'] and address == tailscale['ip']:
                kind, label, subnet = 'tailscale', 'Tailscale 跨网直连', TAILSCALE_NETWORK
            else:
                private_range = next((net for net in PRIVATE_NETWORKS if ip in net), None)
                if not physical or not private_range:
                    continue
                subnet = ipaddress.IPv4Network((ip, mask), strict=False)
                # A misconfigured interface must not admit peers outside its private range.
                if subnet.prefixlen < private_range.prefixlen:
                    subnet = private_range
                kind, label = 'lan', '局域网'
            found[address] = {'interface': name, 'subnet': str(subnet),
                              'kind': kind, 'label': f'{label} ({name})'}
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError):
        return {}
    return found


class NotebookListener(ThreadingHTTPServer):
    request_queue_size = 64


class MobileListener(NotebookListener):
    def __init__(self, address, handler):
        self.workers = threading.BoundedSemaphore(48)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self.workers.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.workers.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.workers.release()

    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], (ssl.SSLError, ConnectionError, TimeoutError)):
            super().handle_error(request, client_address)

    def get_request(self):
        sock, peer = super().get_request()
        try:
            sock.settimeout(15)
            return self.context.wrap_socket(sock, server_side=True, do_handshake_on_connect=False), peer
        except Exception:
            sock.close()
            raise

    def verify_request(self, request, client_address):
        return ipaddress.IPv4Address(client_address[0]) in self.subnet


class MobileAccess:
    def __init__(self, directory, port):
        self.directory = Path(directory) / 'mobile-access'
        self.devices_file = self.directory / 'devices.json'
        self.autostart_file = self.directory / 'autostart.json'
        self.port = port
        self.listener = None
        self.lock = threading.RLock()
        self.code = ''
        self.deadline = 0
        self.attempts = 0

    def _read_autostart(self):
        try:
            cfg = json.loads(self.autostart_file.read_text(encoding='utf-8'))
            if (isinstance(cfg, dict) and cfg.get('enabled') is True and
                    cfg.get('kind') in ('tailscale', 'lan') and isinstance(cfg.get('address'), str)):
                return cfg
        except (OSError, ValueError):
            pass
        return {'enabled': False, 'address': '', 'kind': ''}

    def _save_json(self, dest, payload):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=self.directory)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as tmp:
                json.dump(payload, tmp, ensure_ascii=False)
                tmp.flush()
                os.fsync(tmp.fileno())
            os.replace(name, dest)
        finally:
            Path(name).unlink(missing_ok=True)

    def _write_autostart(self, enabled, address='', kind=''):
        self._save_json(self.autostart_file, {'enabled': enabled, 'address': address if enabled else '',
                                             'kind': kind if enabled else ''})

    def set_autostart(self, enabled):
        if not isinstance(enabled, bool):
            raise ValueError('请明确选择是否自动恢复共享。')
        with self.lock:
            if enabled and not self.listener:
                raise ValueError('请先开启共享后再勾选自动恢复。')
            if enabled:
                self._write_autostart(True, self.listener.server_address[0], self.listener.kind)
            else:
                self._write_autostart(False)

    def resume_autostart(self, handler):
        with self.lock:
            cfg = self._read_autostart()
            if not cfg['enabled']:
                return False
            try:
                interfaces = lan_interfaces()
                match = interfaces.get(cfg['address'])
                if not match or match['kind'] != cfg['kind']:
                    return False
                self._start(cfg['address'], handler, None, match)
                return True
            except (OSError, ValueError):
                return False

    def start(self, address, handler, auto_start=None):
        with self.lock:
            if not isinstance(address, str):
                raise ValueError('请选择一个共享地址。')
            if auto_start is not None and not isinstance(auto_start, bool):
                raise ValueError('请明确选择是否自动恢复共享。')
            if self.listener:
                if self.listener.server_address[0] != address:
                    raise ValueError('请先关闭当前共享，再切换网络地址。')
                if auto_start is not None:
                    self.set_autostart(auto_start)
                return
            interface = lan_interfaces().get(address)
            if not interface:
                raise ValueError('请选择本机当前的 Tailscale 或局域网地址。')
            self._start(address, handler, auto_start, interface)

    def _start(self, address, handler, auto_start, interface):
        if self.listener:
            raise ValueError('共享已开启。')
        try:
            context = tls_identity(self.directory, address)
        except (subprocess.SubprocessError, OSError) as error:
            raise ValueError('无法准备工作台证书，请检查数据目录权限和系统证书工具。') from error
        try:
            listener = MobileListener((address, self.port), handler)
        except OSError as error:
            raise ValueError(f'无法在 {address}:{self.port} 开启共享，请检查网络地址及端口占用情况。') from error
        serving = False
        try:
            listener.context = context
            listener.kind = interface['kind']
            listener.subnet = ipaddress.IPv4Network(interface['subnet'])
            listener.origin = f'https://{address}:{listener.server_port}'
            self.listener = listener
            self.new_code()
            threading.Thread(target=listener.serve_forever, daemon=True, name='lab-note-https').start()
            serving = True
            if auto_start is not None:
                self.set_autostart(auto_start)
        except Exception:
            self.listener = None
            self.code = ''
            if serving:
                listener.shutdown()
            listener.server_close()
            raise

    def shutdown(self):
        """End this session while preserving the desktop user's startup preference."""
        with self.lock:
            listener, self.listener = self.listener, None
            self.code = ''
            self.deadline = 0
            if listener:
                listener.shutdown()
                listener.server_close()

    def stop(self):
        with self.lock:
            try:
                if self.autostart_file.exists():
                    self._write_autostart(False)
            finally:
                self.shutdown()

    def new_code(self):
        with self.lock:
            if not self.listener:
                raise ValueError('请先开启共享。')
            self.code = f'{secrets.randbelow(100_000_000):08d}'
            self.deadline = time.time() + 300
            self.attempts = 0

    def certificate(self):
        cert = self.directory / 'authority' / 'ca.pem'
        return ssl.PEM_cert_to_DER_cert(cert.read_text(encoding='ascii')) if cert.is_file() else None

    def _devices(self):
        try:
            rows = json.loads(self.devices_file.read_text(encoding='utf-8'))
        except FileNotFoundError:
            return []
        return [r for r in rows if r['expires'] > time.time()]

    def status(self):
        tailscale = tailscale_status()
        ordered = sorted(lan_interfaces(tailscale).items(), key=lambda pair: (pair[1]['kind'] != 'tailscale', pair[0]))
        addresses = [dict(address=a, interface=v['interface'], kind=v['kind'], label=v['label']) for a, v in ordered]
        with self.lock:
            cert = self.certificate()
            autostart = self._read_autostart()
            code = self.code if time.time() < self.deadline else ''
            devices = [{k: r[k] for k in ('id', 'name', 'created', 'expires')} for r in self._devices()]
            return {'active': bool(self.listener), 'url': self.listener.origin if self.listener else '',
                    'addresses': addresses, 'auto_start': autostart['enabled'],
                    'auto_start_address': autostart['address'], 'tailscale': tailscale, 'code': code,
                    'expires': int(self.deadline) if code else 0,
                    'fingerprint': hashlib.sha256(cert).hexdigest().upper() if cert else '', 'devices': devices}

    def pair(self, listener, code, name):
        with self.lock:
            if not isinstance(name, str) or not name.strip() or len(name) > 80:
                raise ValueError('请填写设备名称，最多 80 个字符。')
            if not self.code or not listener or listener is not self.listener or time.time() >= self.deadline:
                raise ValueError('配对码已使用或已过期，请在电脑上获取新码。')
            if not isinstance(code, str) or not hmac.compare_digest(code.encode(), self.code.encode()):
                self.attempts += 1
                if self.attempts >= 8:
                    self.code = ''
                raise ValueError('配对码不匹配，请核对电脑上的八位数字。')
            secret = secrets.token_urlsafe(32)
            now = int(time.time())
            device = {'id': secrets.token_hex(8), 'name': name.strip(), 'created': now,
                      'expires': now + DEVICE_LIFETIME, 'digest': hashlib.sha256(secret.encode()).hexdigest()}
            self._save_json(self.devices_file, [*self._devices(), device])
            self.code = ''
            return secret

    def credential(self, listener, cookie_header):
        with self.lock:
            if listener is None or listener is not self.listener:
                return None
            jar = SimpleCookie()
            try:
                jar.load(cookie_header or '')
            except CookieError:
                return None
            value = jar[COOKIE].value if COOKIE in jar else ''
            if not re.fullmatch(r'[A-Za-z0-9_-]{43}', value):
                return None
            digest = hashlib.sha256(value.encode()).hexdigest()
            return value if any(hmac.compare_digest(digest, r['digest']) for r in self._devices()) else None

    def revoke(self, identifier):
        with self.lock:
            devices = self._devices()
            kept = [r for r in devices if r['id'] != identifier]
            if len(kept) == len(devices):
                raise ValueError('该设备已过期或已移除。')
            self._save_json(self.devices_file, kept)
