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
    const wbImg = document.getElementById('workbench-img');
    if (wbImg) {
      const targetSrc = dark ? wbImg.dataset.darkSrc : wbImg.dataset.lightSrc;
      if (targetSrc && wbImg.getAttribute('src') !== targetSrc) wbImg.setAttribute('src', targetSrc);
    }
  };
  apply(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  btn.onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('lab-note-site-theme', next); } catch (_) {}
    apply(next);
  };
})();

/* --- 2. Interactive Multi-Format Culture & Cryo Demo --- */
(function initDemo() {
  const stage = document.getElementById('demo-stage');
  const presetsWrap = document.getElementById('demo-presets');
  const compatEl = document.getElementById('demo-compat');
  const coordEl = document.getElementById('coord');
  const sampleEl = document.getElementById('sample');
  const summaryEl = document.getElementById('summary');
  const microEl = document.getElementById('demo-micro');
  const titleEl = document.getElementById('demo-title');
  if (!stage || !presetsWrap) return;

  const FLASK_SVG = '<svg viewBox="0 0 36 36" aria-hidden="true"><path d="M14 5h8M15 5v6l-7 13a4 4 0 0 0 3.5 6h13a4 4 0 0 0 3.5-6l-7-13V5"/><path d="M10.5 22h15"/></svg>';
  const DISH_SVG = '<svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="13"/><circle cx="18" cy="18" r="9.5" stroke-dasharray="2.5 2.5"/></svg>';

  const MODES = {
    culture: {
      compat: '支持 20 种内置容器：6 / 12 / 24 / 48 / 96 孔板（含白底/黑底/低吸附 U 底）、Transwell 6 / 12 / 24 孔板、T25 / T75 / T175 培养瓶、35–150mm 培养皿，瓶/皿支持 1–100 个同组管理。',
      defaultPreset: 'plate-24',
      presets: [
        {id: 'plate-6', label: '6 孔板', kind: 'plate', rows: 2, cols: 3, title: '6 孔板', micro: '培养容器预览 · 0 / 6 已填写', cls: 'spacious'},
        {id: 'plate-24', label: '24 孔板', kind: 'plate', rows: 4, cols: 6, title: '24 孔板', micro: '培养容器预览 · 0 / 24 已填写', cls: ''},
        {id: 'plate-96', label: '96 孔板', kind: 'plate', rows: 8, cols: 12, title: '96 孔板（含白/黑底）', micro: '培养容器预览 · 0 / 96 已填写', cls: 'dense'},
        {id: 'flask-t75', label: 'T75 培养瓶', kind: 'vessel', vesselKind: 'flask', count: 4, unit: '瓶', title: 'T75 培养瓶组（示例 4 瓶）', micro: '同组管理预览 · 0 / 4 已填写'},
        {id: 'dish-100', label: '100mm 培养皿', kind: 'vessel', vesselKind: 'dish', count: 4, unit: '皿', title: '100mm 培养皿组（示例 4 皿）', micro: '同组管理预览 · 0 / 4 已填写'},
      ],
    },
    cryo: {
      compat: '支持液氮罐、-80℃、-20℃、4℃ 四类设备与 9 大生物样本类别，任意 1×1–12×12 自定义冻存盒尺寸、自定义吊架层级，以及 A1 字母 / 纯数字双坐标编号。',
      defaultPreset: 'cryo-9x9',
      presets: [
        {id: 'cryo-9x9', label: '9×9 (81格)', kind: 'cryo', rows: 9, cols: 9, numbering: 'alpha', title: '9×9 冻存盒（81 格）', micro: '冻存库位预览 · 0 / 81 已占用', cls: 'medium'},
        {id: 'cryo-5x5', label: '5×5 (25格)', kind: 'cryo', rows: 5, cols: 5, numbering: 'alpha', title: '5×5 冻存盒（25 格）', micro: '冻存库位预览 · 0 / 25 已占用', cls: ''},
        {id: 'cryo-10x10', label: '10×10 (100格)', kind: 'cryo', rows: 10, cols: 10, numbering: 'alpha', title: '10×10 冻存盒（100 格）', micro: '冻存库位预览 · 0 / 100 已占用', cls: 'dense'},
        {id: 'cryo-num', label: '数字 1–81', kind: 'cryo', rows: 9, cols: 9, numbering: 'numeric', title: '9×9 冻存盒（数字编号 1–81）', micro: '冻存库位预览 · 0 / 81 已占用', cls: 'medium no-axis'},
      ],
    },
  };

  let currentMode = 'culture';
  let currentPresetId = MODES.culture.defaultPreset;
  let activeButtons = new Map();

  function addAxis(container, label) {
    const el = document.createElement('span');
    el.className = 'axis';
    el.textContent = label;
    el.setAttribute('aria-hidden', 'true');
    container.append(el);
  }

  function resetRecord(preset) {
    coordEl.textContent = '—';
    if (preset.kind === 'cryo') {
      sampleEl.textContent = '尚未选格';
      summaryEl.textContent = '上方可切换常见冻存盒尺寸与编号方式；点选任意格位即可预览定位与入盒说明。';
    } else if (preset.kind === 'vessel') {
      sampleEl.textContent = `尚未选${preset.unit}`;
      summaryEl.textContent = `支持 1–100 个同类${preset.unit}合并为一组统一操作，单${preset.unit}条件分化时也可独立记录。`;
    } else {
      sampleEl.textContent = '尚未选孔';
      summaryEl.textContent = '上方可自由切换孔板、培养瓶或培养皿；点选任意单元即可预览坐标定位与记录入口。';
    }
  }

  function selectUnit(preset, pos) {
    for (const [key, btn] of activeButtons) btn.setAttribute('aria-pressed', String(pos === key));
    coordEl.textContent = pos;
    if (preset.kind === 'cryo') {
      sampleEl.textContent = `${preset.title} · 空白格位`;
      summaryEl.textContent = '启动工作台后，可点选或拖选多个空位批量登记亚克隆、抗性与冻存日期，并导出 A4 分布图。';
    } else if (preset.kind === 'vessel') {
      sampleEl.textContent = `${preset.label} · ${pos}`;
      summaryEl.textContent = '启动工作台后，可批量勾选整组换液/传代，也可单独为其中某一瓶/皿登记不同处理或计数。';
    } else {
      sampleEl.textContent = `${preset.label} · 空白培养孔`;
      summaryEl.textContent = '启动工作台后，可框选多个孔统一登记细胞名称、Day 0、培养基配方、计数并关联实验记录。';
    }
  }

  function renderPreset(preset) {
    stage.innerHTML = '';
    activeButtons = new Map();
    microEl.textContent = preset.micro;
    titleEl.textContent = preset.title;
    resetRecord(preset);

    if (preset.kind === 'plate') {
      const grid = document.createElement('div');
      grid.className = `plate ${preset.cls || ''}`.trim();
      grid.style.setProperty('--cols', String(preset.cols));
      addAxis(grid, '');
      for (let c = 1; c <= preset.cols; c++) addAxis(grid, String(c));
      for (let r = 0; r < preset.rows; r++) {
        const rowChar = String.fromCharCode(65 + r);
        addAxis(grid, rowChar);
        for (let c = 1; c <= preset.cols; c++) {
          const pos = rowChar + c;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'well';
          btn.setAttribute('aria-pressed', 'false');
          btn.textContent = pos;
          btn.setAttribute('aria-label', `${pos} · 空白培养孔`);
          btn.onclick = () => selectUnit(preset, pos);
          grid.append(btn);
          activeButtons.set(pos, btn);
        }
      }
      stage.append(grid);
    } else if (preset.kind === 'vessel') {
      const grid = document.createElement('div');
      grid.className = 'vessel-grid';
      const icon = preset.vesselKind === 'flask' ? FLASK_SVG : DISH_SVG;
      for (let i = 1; i <= preset.count; i++) {
        const pos = `${preset.unit} ${i}`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vessel-unit';
        btn.setAttribute('aria-pressed', 'false');
        btn.innerHTML = `${icon}<div><strong>${pos}</strong><span>${preset.label} · 空白</span></div>`;
        btn.setAttribute('aria-label', `${preset.label} ${pos}`);
        btn.onclick = () => selectUnit(preset, pos);
        grid.append(btn);
        activeButtons.set(pos, btn);
      }
      stage.append(grid);
    } else if (preset.kind === 'cryo') {
      const grid = document.createElement('div');
      grid.className = `cryo-grid ${preset.cls || ''}`.trim();
      grid.style.setProperty('--cols', String(preset.cols));
      const numeric = preset.numbering === 'numeric';
      if (!numeric) {
        addAxis(grid, '');
        for (let c = 1; c <= preset.cols; c++) addAxis(grid, String(c));
      }
      let idx = 1;
      for (let r = 0; r < preset.rows; r++) {
        const rowChar = String.fromCharCode(65 + r);
        if (!numeric) addAxis(grid, rowChar);
        for (let c = 1; c <= preset.cols; c++) {
          const pos = numeric ? String(idx++) : (rowChar + c);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'cryo-slot';
          btn.setAttribute('aria-pressed', 'false');
          btn.innerHTML = `<b>${pos}</b><span>空</span>`;
          btn.setAttribute('aria-label', `${pos} · 空白冻存格位`);
          btn.onclick = () => selectUnit(preset, pos);
          grid.append(btn);
          activeButtons.set(pos, btn);
        }
      }
      stage.append(grid);
    }
  }

  function renderMode(mode, presetId) {
    currentMode = mode;
    const cfg = MODES[mode] || MODES.culture;
    currentPresetId = presetId || cfg.defaultPreset;
    const preset = cfg.presets.find(p => p.id === currentPresetId) || cfg.presets[0];
    currentPresetId = preset.id;

    tabs.forEach(t => t.setAttribute('aria-selected', String(t.dataset.demoMode === mode)));
    if (compatEl) compatEl.textContent = cfg.compat;

    presetsWrap.innerHTML = '';
    for (const p of cfg.presets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'demo-preset';
      btn.dataset.demoPreset = p.id;
      btn.setAttribute('aria-pressed', String(p.id === currentPresetId));
      btn.textContent = p.label;
      btn.onclick = () => {
        currentPresetId = p.id;
        presetsWrap.querySelectorAll('.demo-preset').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.demoPreset === p.id)));
        renderPreset(p);
      };
      presetsWrap.append(btn);
    }
    renderPreset(preset);
  }

  const tabs = document.querySelectorAll('[data-demo-mode]');
  tabs.forEach(tab => {
    tab.onclick = () => renderMode(tab.dataset.demoMode);
  });
  renderMode('culture', MODES.culture.defaultPreset);
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
