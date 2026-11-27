"""Read the installed version and check the official release channel on request."""
from datetime import datetime, timezone
from http.client import HTTPException
import json
from pathlib import Path
import re
import sys
from threading import Lock
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
REPO = 'LumyQAQ/Lab-Note'
DOWNLOAD_URL = 'https://lumyqaq.github.io/Lab-Note/'
RELEASES_URL = 'https://github.com/' + REPO + '/releases'
API_URL = 'https://api.github.com/repos/' + REPO + '/releases'
VERSION_RE = re.compile(r'v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?')
CACHE_TTL_SECONDS = 6 * 3600
_cache_lock = Lock()
_cache = {}


def read_app_version(root=ROOT):
    return (Path(root) / 'VERSION').read_text(encoding='ascii').strip().lstrip('v')


def configured_repo():
    return REPO


def configured_download_url():
    return DOWNLOAD_URL


def parse_semver(tag):
    match = VERSION_RE.fullmatch(str(tag or ''))
    if not match:
        return None
    major, minor, patch, pre = match.groups()
    parts = (pre or '').split('.') if pre else []
    if any(part.isdigit() and len(part) > 1 and part.startswith('0') for part in parts):
        return None
    return (int(major), int(minor), int(patch), pre is None,
            tuple((0, int(part)) if part.isdigit() else (1, part) for part in parts))


def is_newer_version(latest, current):
    left, right = parse_semver(latest), parse_semver(current)
    return left is not None and right is not None and left > right


def _summary(body):
    lines = []
    for raw in str(body or '').splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        line = re.sub(r'^[-*•]\s+', '', line).replace('**', '')
        lines.append(re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', line))
        if len(lines) == 4:
            break
    notes = '；'.join(lines)
    return notes if len(notes) <= 280 else notes[:279] + '…'


def _fetch(path, timeout):
    req = Request(API_URL + path, headers={'Accept': 'application/vnd.github+json',
                                           'User-Agent': 'Lab-Note-update-check'})
    with urlopen(req, timeout=timeout) as response:
        return json.load(response)


def _select_release(windows, fetch):
    if not windows:
        item = fetch('/latest')
        if isinstance(item, dict):
            version = parse_semver(item.get('tag_name'))
            if version and version[3] and not item.get('draft') and not item.get('prerelease'):
                return item
        raise ValueError('GitHub 未返回有效的 macOS 正式版')

    candidates = []
    page = 1
    while True:
        items = fetch(f'?per_page=100&page={page}')
        if not isinstance(items, list):
            raise ValueError('GitHub 未返回版本列表')
        for item in items:
            if not isinstance(item, dict) or item.get('draft'):
                continue
            tag = item.get('tag_name') or ''
            version = parse_semver(tag)
            if not version or not tag.startswith('v'):
                continue
            name = f'Lab-Note-{tag[1:]}-Windows-x64.zip'
            if any(isinstance(asset, dict) and asset.get('name') == name for asset in item.get('assets', [])):
                candidates.append((version, item))
        if len(items) < 100:
            break
        page += 1
    if not candidates:
        raise ValueError('GitHub 未返回 Windows x64 安装包')
    return max(candidates, key=lambda pair: pair[0])[1]


def reset_cache():
    with _cache_lock:
        _cache.clear()


def check_for_updates(current_version=None, force=False, timeout=3.0, fetcher=None, windows=None):
    current = current_version or read_app_version()
    windows = sys.platform == 'win32' if windows is None else windows
    key = (current, windows)
    if fetcher is None and not force:
        with _cache_lock:
            cached = _cache.get(key)
            if cached and time.monotonic() < cached[0]:
                return dict(cached[1])
    result = dict(status='offline', current_version=current, latest_version='', latest_tag='',
                  has_update=False, release_name='', notes='', release_url=RELEASES_URL,
                  download_url=DOWNLOAD_URL, published_at='', repo=REPO,
                  checked_at=datetime.now(timezone.utc).isoformat(timespec='seconds'))
    try:
        release = _select_release(windows, fetcher or (lambda path: _fetch(path, timeout)))
        tag = release['tag_name']
        version = tag.lstrip('v')
        result.update(status='ok', latest_tag=tag, latest_version=version,
                      has_update=is_newer_version(tag, current), release_name=str(release.get('name') or tag),
                      notes=_summary(release.get('body')), release_url=RELEASES_URL + '/tag/' + tag,
                      published_at=str(release.get('published_at') or ''))
    except (OSError, HTTPException, ValueError, TypeError, KeyError, EOFError) as err:
        result['error'] = str(err)[:160]
    if fetcher is None:
        ttl = CACHE_TTL_SECONDS if result['status'] == 'ok' else 60
        with _cache_lock:
            _cache[key] = (time.monotonic() + ttl, dict(result))
    return result
