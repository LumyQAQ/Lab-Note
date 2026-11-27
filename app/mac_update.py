"""Install the signed stable ZIP while keeping the notebook data outside the app."""
import argparse
from contextlib import closing, contextmanager
import ctypes
from datetime import datetime
import hashlib
from http.client import HTTPException
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
from urllib.error import URLError
from urllib.request import Request, urlopen
import zipfile

import launch
from platform_config import TZ, default_data_dir, port_value
from update_check import RELEASES_URL, check_for_updates, is_newer_version, parse_semver, read_app_version

ROOT = Path(__file__).resolve().parents[1]
SIGNERS = Path('docs/downloads/allowed_signers')
UPDATER = '更新培养工作台.command'
MAX_ARCHIVE = 100 * 1024 * 1024


def download(url, target, limit):
    with urlopen(Request(url, headers={'User-Agent': 'Lab-Note-updater'}), timeout=30) as response:
        if not response.geturl().startswith('https://'):
            raise ValueError('下载连接未使用 HTTPS')
        with target.open('xb') as out:
            while True:
                block = response.read(256 * 1024)
                if not block:
                    break
                limit -= len(block)
                if limit < 0:
                    raise ValueError('下载文件超过大小限制')
                out.write(block)


def stage_release(root, tag, work):
    parsed = parse_semver(tag)
    if not parsed or not parsed[3] or not tag.startswith('v'):
        raise ValueError('更新包缺少正式版本号')
    archive = work / f'lab-note-{tag}.zip'
    sig = archive.with_suffix('.zip.sig')
    for target, limit in ((archive, MAX_ARCHIVE), (sig, 16384)):
        download(f'{RELEASES_URL}/download/{tag}/{target.name}', target, limit)
    # Always verify against the key in the current installation.
    with archive.open('rb') as source:
        subprocess.run(['/usr/bin/ssh-keygen', '-Y', 'verify', '-f', str(root / SIGNERS),
                        '-I', 'LumyQAQ', '-n', 'lab-note-release', '-s', str(sig)],
                       stdin=source, check=True)
    unpacked = work / 'Lab-Note'
    with zipfile.ZipFile(archive) as package:
        if sum(entry.file_size for entry in package.infolist()) > MAX_ARCHIVE * 3:
            raise ValueError('解压内容超过大小限制')
        for entry in package.infolist():
            path = PurePosixPath(entry.filename)
            if path.parts[:1] != ('Lab-Note',) or '..' in path.parts or '\\' in entry.filename:
                raise ValueError('更新包目录无效')
            dest = work.joinpath(*path.parts)
            mode = entry.external_attr >> 16
            if entry.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
                continue
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                raise ValueError('更新包包含不支持的文件类型')
            dest.parent.mkdir(parents=True, exist_ok=True)
            with package.open(entry) as src, dest.open('xb') as out:
                shutil.copyfileobj(src, out)
            dest.chmod(0o755 if dest.suffix == '.command' else 0o644)
    if read_app_version(unpacked) != tag[1:] or not all((unpacked / path).is_file() for path in
            (SIGNERS, UPDATER, '启动实验日记.command', 'app/server.py', 'app/launch.py', 'app/mac_update.py')):
        raise ValueError('已签名的安装包与目标版本或安装结构不符')
    return unpacked


def copy_database(source, destination):
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as original:
        with closing(sqlite3.connect(destination)) as saved:
            original.backup(saved)
            if saved.execute('PRAGMA integrity_check').fetchone() != ('ok',):
                raise ValueError('数据库副本完整性校验失败')


def backup_database(data):
    database = data / 'culture.sqlite3'
    if not database.exists():
        return None
    backups = data / 'backups'
    backups.mkdir(mode=0o700, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix=f'culture-{datetime.now(TZ):%Y%m%d-%H%M%S}-update-', suffix='.sqlite3', dir=backups, delete=False) as tmp:
        target = Path(tmp.name)
    try:
        copy_database(database, target)
        digest = hashlib.sha256()
        with target.open('rb') as saved:
            for block in iter(lambda: saved.read(1024 * 1024), b''):
                digest.update(block)
        target.with_suffix('.sha256').write_text(f'{digest.hexdigest()}  {target.name}\n', encoding='ascii')
    except BaseException:
        target.unlink()
        raise
    print(f'升级前数据库备份：{target}', flush=True)
    return target


def swap_directories(left, right):
    # macOS renamex_np(RENAME_SWAP) also leaves a complete install after a power loss.
    rename = ctypes.CDLL(None, use_errno=True).renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(os.fsencode(left), os.fsencode(right), 0x00000002):
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


@contextmanager
def install_lock(root):
    import fcntl
    fd = os.open(root.parent, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def install(root, candidate, data, requested_port):
    if data == root or root in data.parents or data in root.parents:
        raise ValueError('请选择独立于程序目录的数据目录')
    data.mkdir(mode=0o700, parents=True, exist_ok=True)
    with launch.launch_lock(data):
        port, info = launch.existing(data, requested_port)
        if port and info.get('install_dir') != str(root):
            raise ValueError('此数据目录正由另一份或较早版本的工作台使用，请先关闭它')
        if port:
            launch.stop(port, info, data)
        swapped = False
        backup = None
        try:
            backup = backup_database(data)
            swap_directories(root, candidate)
            swapped = True
            if port:
                launch.start(data, port)
        except BaseException:
            if swapped:
                swap_directories(root, candidate)
                if backup and port:
                    copy_database(backup, data / 'culture.sqlite3')
            if port and not launch.running_server(port, data):
                launch.start(data, port)
            raise
    return port


def main():
    parser = argparse.ArgumentParser(description='从官方 GitHub Release 验签并升级当前 macOS 解压版。')
    parser.add_argument('--data-dir', type=Path, default=default_data_dir(), help='启动器正在使用的数据目录')
    parser.add_argument('--port', type=port_value, default=None, help='手动启动服务时指定其端口')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise ValueError('此脚本适用于 macOS 解压版')
    if any((folder / '.git').exists() for folder in (ROOT, *ROOT.parents)):
        raise ValueError('此目录位于 Git 工作区。请在官方 ZIP 的独立解压目录运行更新脚本。')
    with install_lock(ROOT):
        current = read_app_version()
        if not parse_semver(current):
            raise ValueError('当前程序缺少有效版本号')
        release = check_for_updates(current_version=current, windows=False, force=True, timeout=10)
        if release['status'] != 'ok':
            raise ValueError('无法查询 GitHub 正式版：' + release['error'])
        tag = release['latest_tag']
        if not is_newer_version(tag, current):
            print(f'当前版本 {current}，无需更新。')
            return
        print(f'正在下载并校验 {tag}…', flush=True)
        # Retain the previous entire installation, including any user-added files.
        with tempfile.TemporaryDirectory(prefix='.lab-note-download-', dir=ROOT.parent) as tmp:
            staged = stage_release(ROOT, tag, Path(tmp))
            archive_dir = Path(tempfile.mkdtemp(prefix=f'Lab-Note-previous-{current}-', dir=ROOT.parent))
            previous = archive_dir / 'Lab-Note'
            staged.rename(previous)
            port = install(ROOT, previous, args.data_dir.expanduser().resolve(), args.port)
        print(f'已更新到 {tag}。原程序目录：{previous}')
        print(f'工作台已重启：{launch.endpoint(port)}' if port else '双击「启动实验日记.command」即可打开。')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, HTTPException, URLError, subprocess.SubprocessError, sqlite3.Error, zipfile.BadZipFile) as err:
        raise SystemExit(f'更新未完成：{err}') from None
