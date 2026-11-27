const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

async function colors(locator) {
  await locator.waitFor({ state: 'visible' });
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { fg: style.color, bg: style.backgroundColor, border: style.borderTopColor };
  });
}

function rgb(color) {
  const match = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color);
  assert.ok(match, 'Expected an opaque RGB color, got ' + color);
  return match.slice(1).map(Number);
}

function luminance(color) {
  const [r, g, b] = rgb(color).map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function readable({ fg, bg }, label) {
  const [low, high] = [luminance(fg), luminance(bg)].sort((a, b) => a - b);
  const contrast = (high + 0.05) / (low + 0.05);
  assert.ok(contrast >= 4.5, label + ' contrast ' + contrast.toFixed(2) + ' (' + fg + ' on ' + bg + ')');
}

function hue(color, expected, label) {
  const [r, g, b] = rgb(color);
  const matches = { amber: r > g && g > b, blue: b > g && g > r, green: g > r && g > b, red: r > g && r > b };
  assert.ok(matches[expected], label + ' expected ' + expected + ', got ' + color);
}

async function darkSurface(locator, label) {
  const style = await colors(locator);
  assert.ok(luminance(style.bg) < 0.08, label + ' has a light background: ' + style.bg);
  readable(style, label);
  return style;
}

test('culture status colors and editor surfaces in light and dark themes', {
  skip: process.env.LAB_NOTE_BROWSER_TEST !== '1' && 'Set LAB_NOTE_BROWSER_TEST=1 to run the browser suite',
  timeout: 90000,
}, async () => {
  const { chromium } = require('playwright-core');
  const cwd = process.env.LAB_NOTE_APP_ROOT || path.resolve(__dirname, '..');
  const python = process.env.LAB_NOTE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-theme-qa-'));
  const ready = path.join(dir, 'ready.json');
  const server = spawn(python, ['-B', path.join(cwd, 'app', 'server.py'), '--data-dir', dir,
    '--port', 'auto', '--ready-file', ready], { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
  const stopped = once(server, 'exit');
  let browser;
  try {
    for (let i = 0; i < 300 && !fs.existsSync(ready) && server.exitCode === null; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const url = 'http://127.0.0.1:' + JSON.parse(fs.readFileSync(ready)).port;
    const boot = await (await fetch(url + '/api/state')).json();
    const expectedVersion = fs.readFileSync(path.join(cwd, 'VERSION'), 'utf8').trim();
    assert.equal(boot.app_version, expectedVersion);
    let state = boot.state;
    assert.equal(state.containers.length, 0);
    async function command(action, payload) {
      const res = await fetch(url + '/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Token': boot.token },
        body: JSON.stringify({ revision: state.revision, action, payload }),
      });
      const response = await res.json();
      assert.equal(res.status, 200, JSON.stringify(response));
      state = response.state;
    }
    for (const name of ['Pending QA', 'Checked QA']) {
      await command('create', { name, type: '24孔板', location: '' });
      const id = state.containers.find((item) => item.name === name).id;
      await command('wells', { id, wells: ['A1'], patch: {
        cell: 'Sample QA', kind: '细胞系', day0: '2020-01-01', anchor: '传代',
        experiment: 'QA-EXPERIMENT', medium: { base: 'Synthetic A' },
      } });
      if (name === 'Checked QA') await command('check', { id });
    }
    await command('cryo_stock_create', { name: 'Synthetic lot', at: '2020-01-01', vials: 3, storage_stage: 'unassigned' });
    const lot = state.frozen_batches[0].id;
    await command('cryo_discard_vials', { lot_id: lot, vials: 1, at: '2020-01-02', is_contamination: true });

    browser = await chromium.launch({
      headless: true, executablePath: process.env.LAB_NOTE_BROWSER_EXECUTABLE, args: ['--no-proxy-server'],
    });
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);

    const card = (name) => page.locator('.home-container').filter({ has: page.getByRole('heading', { name }) });
    const pending = card('Pending QA'), checked = card('Checked QA');
    const pendingBadge = pending.getByText('今日待核对', { exact: true });
    const checkedBadge = checked.getByText('今日已核对', { exact: true });
    const dialog = page.locator('#quick-medium-dialog[open]');
    const footer = dialog.locator('.dialog-actions');
    async function openHalf() {
      await pending.locator('[data-home-action="medium"]').click();
      await pending.locator('[data-home-medium="half"]').click();
      await dialog.getByRole('heading', { name: '半换液', exact: true }).waitFor();
    }
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    const originalBadge = await colors(pendingBadge);
    await openHalf();
    const originalFooter = await colors(footer);
    assert.ok(luminance(originalFooter.bg) > 0.65, 'Light theme footer should stay light');
    await dialog.getByRole('button', { name: '取消' }).click();

    await page.locator('#theme-toggle').click();
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    hue((await darkSurface(pendingBadge, 'Pending badge')).fg, 'amber', 'Pending badge');
    hue((await darkSurface(checkedBadge, 'Checked badge')).fg, 'blue', 'Checked badge');
    for (const container of [pending, checked]) {
      const status = container.getByText('在培养', { exact: true });
      hue((await darkSurface(status, 'Active culture badge')).fg, 'green', 'Active culture badge');
    }
    hue((await colors(pending)).border, 'amber', 'Pending card border');
    hue((await colors(checked)).border, 'blue', 'Checked card border');
    await page.locator('[data-home-mode=experiments]').click();
    const active = page.locator('.home-experiment').getByText('相关培养进行中', { exact: true });
    hue((await darkSurface(active, 'Active badge')).fg, 'green', 'Active badge');
    await page.locator('[data-home-mode=containers]').click();

    await openHalf();
    await darkSurface(footer, 'Half-medium sticky footer');
    for (const button of ['取消', '确认半换液'])
      readable(await colors(footer.getByRole('button', { name: button })), button);
    await dialog.locator('[data-quick-medium-edit]').check();
    await darkSurface(dialog.locator('[data-medium-field=base]'), 'Medium recipe base');
    await dialog.getByRole('button', { name: '取消' }).click();

    await pending.locator('[data-home-open]').first().click();
    await darkSurface(page.locator('#count-editor [data-count-field=mode]'), 'Count editor');
    await page.locator('[data-view=labs]').click();
    await page.locator('#lab-new').click();
    await darkSurface(page.locator('#lab-record-dialog[open] .lab-editor-actions'), 'Experiment editor footer');
    await page.locator('#lab-cancel').click();
    await page.locator('[data-view=cryo]').click();
    await page.locator('[data-cryo-tab=batches]').click();
    const batch = page.locator('[data-batch-card="' + lot + '"]');
    await batch.locator('summary').click();
    hue((await darkSurface(batch.locator('.state-badge.is-contam'), 'Contamination badge')).fg, 'red', 'Contamination badge');

    await page.locator('[data-view=backup]').click();
    assert.equal(await page.locator('#version-card h3').innerText(), '程序版本与更新 · v' + expectedVersion);
    await page.locator('[data-view=home]').click();
    await page.locator('#theme-toggle').click();
    assert.deepEqual(await colors(pendingBadge), originalBadge);
    await openHalf();
    assert.deepEqual(await colors(footer), originalFooter);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.kill();
    await stopped;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
