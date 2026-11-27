const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {test} = require('node:test');
const assert = require('node:assert/strict');

test('sample categories, draft, copy, subject linkage and mobile inventory controls', {
  skip: process.env.LAB_NOTE_BROWSER_TEST !== '1' && 'Set LAB_NOTE_BROWSER_TEST=1 to run',
  timeout: 120000,
}, async () => {
  const {chromium} = require('playwright-core');
  const cwd = process.env.LAB_NOTE_APP_ROOT || path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-biobank-qa-'));
  const ready = path.join(dir, 'ready.json');
  const server = spawn(process.env.LAB_NOTE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['-B', cwd + '/app/server.py', '--data-dir', dir, '--port', 'auto', '--ready-file', ready],
    {cwd, stdio: ['ignore', 'ignore', 'pipe']});
  const stopped = once(server, 'exit');
  let browser;
  try {
    server.stderr.on('data', chunk => process.stderr.write(chunk));
    for (let i = 0; i < 300 && !fs.existsSync(ready) && server.exitCode === null; i++)
      await new Promise(r => setTimeout(r, 50));
    const url = 'http://127.0.0.1:' + JSON.parse(fs.readFileSync(ready)).port;
    const boot = await (await fetch(url + '/api/state')).json();
    let state = boot.state;
    assert.equal((state.frozen_batches || []).length, 0);
    async function cmd(action, payload) {
      const res = await fetch(url + '/api/command', {method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Lab-Token': boot.token},
        body: JSON.stringify({revision: state.revision, action, payload})});
      const data = await res.json();
      assert.equal(res.status, 200, JSON.stringify(data));
      state = data.state;
    }
    await cmd('cryo_setup_preset', {device_name: 'Synthetic freezer', device_kind: 'minus80',
      box_count: 1, rows: 3, cols: 4});
    const boxId = state.cryo_storage.boxes[0].id;
    await cmd('cryo_stock_create', {name: 'Synthetic cell', cell_kind: '原代', at: '2020-01-01',
      vials: 1, source_subject: 'Subject-test', storage_stage: 'stored',
      placements: [{box_id: boxId, slot: 'A1'}]});
    browser = await chromium.launch({headless: true, executablePath: process.env.LAB_NOTE_BROWSER_EXECUTABLE,
      args: ['--no-proxy-server']});
    const page = await browser.newPage({viewport: {width: 1440, height: 980}});
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.goto(url);
    await page.click('[data-view="cryo"]');
    const slot = key => page.locator(`[data-cryo-slot="${key}"]`);
    async function save(button) {
      const response = page.waitForResponse(r => r.url().endsWith('/api/command'));
      await button.click();
      const res = await response;
      const data = await res.json();
      assert.equal(res.status(), 200, JSON.stringify(data));
      state = data.state;
      await page.waitForFunction(() => !busy);
    }
    await slot('B1').click();
    const form = page.locator('#cryo-inline-stock-form');
    const field = key => form.locator(`[name="${key}"]`);
    assert.equal(await field('sample_category').locator('option').count(), 9);
    await field('sample_category').selectOption('protein');
    assert.equal(await field('cell_kind').isVisible(), false);
    await field('name').fill('Synthetic protein');
    await field('source_subject').fill('Subject-test');
    await field('disease_model').fill('User model');
    await field('specimen_type').fill('User subtype');
    await field('meta_concentration').fill('12 test units');
    await slot('B2').click();
    assert.equal(await field('sample_category').inputValue(), 'protein');
    assert.equal(await field('source_subject').inputValue(), 'Subject-test');
    assert.equal(await field('meta_concentration').inputValue(), '12 test units');
    await save(form.locator('button[type=submit]'));
    const lot = state.frozen_batches.find(x => x.name === 'Synthetic protein');
    assert.equal(lot.vials, 2);
    assert.equal(lot.sample_category, 'protein');
    assert.deepEqual(lot.special_treatments, []);
    assert.deepEqual(lot.sources, []);
    await slot('B1').click();
    assert.equal(await page.locator('#cryo-slot-thaw').count(), 0);
    assert.match(await page.locator('.cryo-cross-panel').innerText(), /Synthetic cell/);
    await page.locator('#cryo-slot-copy').click();
    await slot('B3').click();
    const copy = page.locator('#cryo-copy-form');
    assert.equal(await copy.locator('[name=sample_category]').inputValue(), 'protein');
    assert.equal(await copy.locator('[name=meta_concentration]').inputValue(), '12 test units');
    await save(page.locator('#cryo-mode-confirm'));
    assert.equal(state.frozen_batches.at(-1).source_subject, 'Subject-test');
    assert.equal(state.frozen_batches.at(-1).sample_meta.concentration, '12 test units');
    await page.locator('[data-cryo-cat="protein"]').click();
    assert.match(await slot('A1').getAttribute('class'), /is-dim/);
    await page.locator('#cryo-clear-filters').click();
    await page.locator('#cryo-m80-toggle').click();
    assert.match(await slot('A1').getAttribute('class'), /is-match/);
    assert.match(await slot('B1').getAttribute('class'), /is-dim/);
    await page.locator('#cryo-clear-filters').click();
    await slot('A1').click();
    assert.match(await page.locator('.cryo-alert-box.is-m80-warning').innerText(), /不代表实际/);
    await page.setViewportSize({width: 390, height: 844});
    await slot('C1').click();
    await field('sample_category').selectOption('rna');
    await field('name').fill('Synthetic RNA');
    await field('meta_concentration').fill('8 ng/μL');
    await save(form.locator('button[type=submit]'));
    assert.equal(state.frozen_batches.at(-1).sample_category, 'rna');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server.exitCode === null) server.kill('SIGTERM');
    await stopped;
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
