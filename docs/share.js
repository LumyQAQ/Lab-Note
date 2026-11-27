'use strict';

const REPO = 'LumyQAQ/Lab-Note';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const INITIAL_VISIBLE = 3;

/* --- 1. Theme Toggle (Light / Botanical Dark) --- */
(function initTheme() {
  const btn = document.getElementById('site-theme-toggle');
  if (!btn) return;
  const apply = theme => {
    const dark = theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    btn.setAttribute('aria-pressed', String(dark));
    btn.textContent = dark ? '浅色' : '深色';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#111815' : '#f6f6ee');
  };
  apply(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  btn.onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('lab-note-site-theme', next); } catch (_) {}
    apply(next);
  };
})();

/* --- 2. Interactive Blank Plate & Cryo Box Demo --- */
(function initDemo() {
  const plate = document.getElementById('plate');
  const cryoGrid = document.getElementById('cryo-grid');
  const coordEl = document.getElementById('coord');
  const sampleEl = document.getElementById('sample');
  const summaryEl = document.getElementById('summary');
  const microEl = document.getElementById('demo-micro');
  const titleEl = document.getElementById('demo-title');
  if (!plate || !cryoGrid) return;

  const plateButtons = new Map();
  const cryoButtons = new Map();

  function addAxis(container, label) {
    const el = document.createElement('span');
    el.className = 'axis';
    el.textContent = label;
    el.setAttribute('aria-hidden', 'true');
    container.append(el);
  }

  function selectPlate(pos) {
    for (const [key, btn] of plateButtons) btn.setAttribute('aria-pressed', String(pos === key));
    coordEl.textContent = pos;
    sampleEl.textContent = '空白培养孔';
    summaryEl.textContent = '启动工作台后，可在此登记细胞名称、Day 0、培养基配方、计数并关联实验记录。';
  }

  function selectCryo(pos) {
    for (const [key, btn] of cryoButtons) btn.setAttribute('aria-pressed', String(pos === key));
    coordEl.textContent = pos;
    sampleEl.textContent = '空白冻存格位';
    summaryEl.textContent = '启动工作台后，可点选或拖选多个空位批量登记亚克隆、抗性与冻存日期，并打印本盒分布图。';
  }

  // Build 24-well plate (A1-D6)
  addAxis(plate, '');
  for (let c = 1; c <= 6; c++) addAxis(plate, String(c));
  for (const row of 'ABCD') {
    addAxis(plate, row);
    for (let c = 1; c <= 6; c++) {
      const pos = row + c;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'well';
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = pos;
      btn.setAttribute('aria-label', `${pos} · 空白培养孔`);
      btn.onclick = () => selectPlate(pos);
      plate.append(btn);
      plateButtons.set(pos, btn);
    }
  }

  // Build 5x5 LN2 cryo box (A1-E5)
  addAxis(cryoGrid, '');
  for (let c = 1; c <= 5; c++) addAxis(cryoGrid, String(c));
  for (const row of 'ABCDE') {
    addAxis(cryoGrid, row);
    for (let c = 1; c <= 5; c++) {
      const pos = row + c;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cryo-slot';
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = `<b>${pos}</b><span>空</span>`;
      btn.setAttribute('aria-label', `${pos} · 空白冻存格位`);
      btn.onclick = () => selectCryo(pos);
      cryoGrid.append(btn);
      cryoButtons.set(pos, btn);
    }
  }

  const tabs = document.querySelectorAll('[data-demo-mode]');
  tabs.forEach(tab => {
    tab.onclick = () => {
      const mode = tab.dataset.demoMode;
      tabs.forEach(t => t.setAttribute('aria-selected', String(t.dataset.demoMode === mode)));
      const isCryo = mode === 'cryo';
      plate.hidden = isCryo;
      cryoGrid.hidden = !isCryo;
      microEl.textContent = isCryo ? '液氮盒预览 · 0 / 25 已占用' : '孔位预览 · 0 / 24 已填写';
      titleEl.textContent = isCryo ? '空白 5×5 冻存盒' : '空白培养板';
      coordEl.textContent = '—';
      sampleEl.textContent = isCryo ? '尚未选格' : '尚未选孔';
      summaryEl.textContent = isCryo
        ? '点选任意冻存格位，可预览液氮盒坐标定位与批量入盒说明。'
        : '点选任意培养孔，可预览空白孔板的坐标定位与记录入口。';
      for (const btn of plateButtons.values()) btn.setAttribute('aria-pressed', 'false');
      for (const btn of cryoButtons.values()) btn.setAttribute('aria-pressed', 'false');
    };
  });
})();

/* --- 3. Live GitHub Releases Sync & Per-Generation Changelog --- */
function parseSemver(ver) {
  const m = String(ver || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function compareSemverDesc(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pb[i] !== pa[i]) return pb[i] - pa[i];
  }
  return 0;
}

function cleanReleaseBody(body) {
  if (!body || typeof body !== 'string') return [];
  const skipPrefixes = [
    'macOS：解压后',
    'Windows：全部解压',
    'Windows：解压后',
    '软件作者',
    '先用旧版下载',
    '[软件主页]',
    '作者：',
    '两平台均在本机'
  ];
  const lines = body.replace(/\r/g, '').split('\n');
  const items = [];
  let inUpgradeSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,4}\s*/.test(line)) {
      const head = line.replace(/^#{1,4}\s*/, '');
      inUpgradeSection = /升级|安装|校验|下载/.test(head);
      continue;
    }
    if (inUpgradeSection) continue;
    let text = line
      .replace(/^[-*•]\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();
    if (!text) continue;
    if (skipPrefixes.some(p => text.startsWith(p))) continue;
    items.push(text);
  }
  return items;
}

function previewNumber(tag) {
  return Number(/-preview\.(\d+)$/.exec(tag)?.[1] || 0);
}

function normalizeGitHubReleases(rawList, staticList) {
  const grouped = new Map(staticList.map(item => [item.version, item]));
  const live = new Map();
  for (const rel of rawList) {
    if (!rel || rel.draft) continue;
    const tag = String(rel.tag_name || '').trim();
    const match = /^v(\d+\.\d+\.\d+)(-preview\.\d+)?$/.exec(tag);
    if (!match || (!match[2] && rel.prerelease)) continue;
    const [, version, preview] = match;
    const platform = preview ? 'win' : 'mac';
    const filename = preview ? `Lab-Note-${version}${preview}-Windows-x64.zip`
      : tag === 'v1.0.0' ? 'lab-note-v1.0.zip' : `lab-note-${tag}.zip`;
    const asset = rel.assets?.find(a => a.name === filename && a.browser_download_url);
    if (!asset) continue;

    const pair = live.get(version) || {};
    const previous = pair[platform]?.tag || grouped.get(version)?.[platform]?.tag;
    if (previous && previewNumber(previous) > previewNumber(tag)) continue;
    pair[platform] = { tag, asset, rel };
    live.set(version, pair);
  }

  for (const [version, pair] of live) {
    const snapshot = grouped.get(version);
    const entry = { ...snapshot, version, highlights: [...(snapshot?.highlights || [])] };
    for (const platform of ['mac', 'win']) {
      if (!pair[platform]) continue;
      const { tag, asset, rel } = pair[platform];
      entry[platform] = {
        tag,
        release_url: rel.html_url || `https://github.com/${REPO}/releases/tag/${tag}`,
        download_url: asset.browser_download_url
      };
      const date = String(rel.published_at || '').slice(0, 10);
      if (date && (!entry.date || date > entry.date)) entry.date = date;
      if (!entry.title) entry.title = String(rel.name || '').replace(/^Lab Note\s*/i, '').trim();
      if (!snapshot?.highlights?.length || snapshot[platform]?.tag !== tag) {
        entry.highlights.push(...cleanReleaseBody(rel.body));
      }
    }
    entry.highlights = [...new Set(entry.highlights)];
    grouped.set(version, entry);
  }

  return [...grouped.values()]
    .filter(item => item.mac || item.win)
    .sort((a, b) => compareSemverDesc(a.version, b.version));
}

function updateHeroAndInstall(releases) {
  const latest = releases[0];
  if (!latest) return;
  const verPill = document.getElementById('hero-version-text');
  if (verPill) verPill.textContent = `v${latest.version} ${latest.mac ? '最新正式版' : 'Windows 预览版'}`;
  const installVersion = document.getElementById('install-latest-version');
  if (installVersion) installVersion.textContent = `v${latest.version}`;

  for (const platform of ['mac', 'win']) {
    const pkg = releases.find(r => r[platform]?.download_url)?.[platform];
    if (!pkg) continue;
    for (const section of ['hero', 'guide']) {
      const link = document.getElementById(`${section}-${platform}-dl`);
      const version = document.getElementById(`${section}-${platform}-ver`);
      if (link) link.href = pkg.download_url;
      if (version) version.textContent = pkg.tag;
    }
    const releaseLink = document.getElementById(`guide-${platform}-rel`);
    if (releaseLink) releaseLink.href = pkg.release_url;
  }
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderTimeline(releases, showAll) {
  const listEl = document.getElementById('release-timeline');
  const moreWrap = document.getElementById('timeline-more-wrap');
  const moreBtn = document.getElementById('timeline-more-btn');
  if (!listEl) return;

  const visible = showAll ? releases : releases.slice(0, INITIAL_VISIBLE);
  listEl.innerHTML = visible.map((rel, idx) => {
    const isLatest = idx === 0;
    const items = (rel.highlights || []).length
      ? rel.highlights
      : ['请查看该版本的 GitHub 发布说明。'];
    const macLink = rel.mac
      ? `<a href="${escHtml(rel.mac.release_url)}" target="_blank" rel="noopener">macOS ${escHtml(rel.mac.tag)} 说明 ↗</a>`
      : '';
    const winLink = rel.win
      ? `<a href="${escHtml(rel.win.release_url)}" target="_blank" rel="noopener">Windows ${escHtml(rel.win.tag)} 说明 ↗</a>`
      : '';
    const macDl = rel.mac?.download_url && /\.zip$/i.test(rel.mac.download_url)
      ? `<a href="${escHtml(rel.mac.download_url)}" ${rel.mac.download_url.startsWith('downloads/') ? 'download' : 'target="_blank" rel="noopener"'}>下载 macOS ZIP ↓</a>`
      : '';
    const winDl = rel.win?.download_url && /\.zip$/i.test(rel.win.download_url)
      ? `<a href="${escHtml(rel.win.download_url)}" target="_blank" rel="noopener">下载 Windows ZIP ↓</a>`
      : '';
    return `<li class="release-card ${isLatest ? 'is-latest' : ''}">
      <div class="release-rail">
        <div class="release-ver-row">
          <span class="release-ver">v${escHtml(rel.version)}</span>
          ${isLatest ? '<span class="release-tag">最新</span>' : ''}
        </div>
        ${rel.date ? `<span class="release-date">${escHtml(rel.date)}</span>` : ''}
        <div class="release-platforms">
          ${rel.mac ? '<span class="plat-pill">macOS 正式版</span>' : ''}
          ${rel.win ? '<span class="plat-pill">Windows x64</span>' : ''}
        </div>
      </div>
      <div class="release-body">
        <h3>${escHtml(rel.title || `Lab Note v${rel.version}`)}</h3>
        <ul class="release-items">${items.map(t => `<li>${escHtml(t)}</li>`).join('')}</ul>
        <div class="release-links">${[macDl, winDl, macLink, winLink].filter(Boolean).join('')}</div>
      </div>
    </li>`;
  }).join('');

  if (moreWrap && moreBtn) {
    const hiddenCount = releases.length - INITIAL_VISIBLE;
    if (hiddenCount > 0) {
      moreWrap.hidden = false;
      moreBtn.textContent = showAll ? '收起早期版本' : `展开更早版本（其余 ${hiddenCount} 代）`;
    } else {
      moreWrap.hidden = true;
    }
  }
}

(async function initChangelog() {
  const statusEl = document.getElementById('changelog-sync-status');
  const moreBtn = document.getElementById('timeline-more-btn');
  let showAll = false;
  let currentReleases = [];

  if (moreBtn) {
    moreBtn.onclick = () => {
      showAll = !showAll;
      renderTimeline(currentReleases, showAll);
    };
  }

  // 1. Load static snapshot first for instant render (zero flicker, works offline)
  let staticReleases = [];
  try {
    const res = await fetch('releases.json', { cache: 'no-cache' });
    if (res.ok) staticReleases = await res.json();
  } catch (_) {}

  if (staticReleases.length) {
    currentReleases = normalizeGitHubReleases([], staticReleases);
    updateHeroAndInstall(currentReleases);
    renderTimeline(currentReleases, showAll);
    if (statusEl) statusEl.textContent = `已载入 ${currentReleases.length} 代版本记录`;
  }

  // 2. Live sync from GitHub Releases API so future releases appear automatically
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const liveRaw = await res.json();
    const merged = normalizeGitHubReleases(liveRaw, staticReleases);
    if (merged.length) {
      currentReleases = merged;
      renderTimeline(currentReleases, showAll);
      updateHeroAndInstall(currentReleases);
      if (statusEl) {
        statusEl.textContent = `已同步 GitHub Releases · 共 ${currentReleases.length} 代版本`;
      }
    }
  } catch (_) {
    clearTimeout(timer);
    if (statusEl && currentReleases.length) {
      statusEl.textContent = `本地版本归档 · 共 ${currentReleases.length} 代版本`;
    }
  }
})();
