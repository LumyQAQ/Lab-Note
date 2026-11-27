const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
// Set LAB_NOTE_BROWSER_TEST=1 to run with playwright-core and a Chromium browser.
// LAB_NOTE_BROWSER_EXECUTABLE can select an installed browser; LAB_NOTE_APP_ROOT can point at an extracted release.
const { test } = require('node:test');
const { once } = require('node:events');
test(
  'inventory map, templates, draft preservation, withdrawal records and printing',
  {
    skip: process.env.LAB_NOTE_BROWSER_TEST !== '1' && 'Set LAB_NOTE_BROWSER_TEST=1 to run the browser suite',
    timeout: 120000,
  },
  async () => {
    const { chromium } = require('playwright-core');
    const cwd = process.env.LAB_NOTE_APP_ROOT || path.resolve(__dirname, '..');
    const python = process.env.LAB_NOTE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-cryo-qa-'));
    const ready = path.join(dir, 'ready.json');
    const server = spawn(
      python,
      ['-B', cwd + '/app/server.py', '--data-dir', dir, '--port', 'auto', '--ready-file', ready],
      { cwd, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const stopped = once(server, 'exit');
    let browser;
    try {
      server.stderr.on('data', (chunk) => process.stderr.write(chunk));
      for (let i = 0; i < 300 && !fs.existsSync(ready) && server.exitCode === null; i++)
        await new Promise((r) => setTimeout(r, 50));
      const url = 'http://127.0.0.1:' + JSON.parse(fs.readFileSync(ready)).port;
      const boot = await (await fetch(url + '/api/state')).json();
      assert.equal(boot.state.containers.length, 0);
      let state = boot.state;
      async function cmd(action, payload) {
        const res = await fetch(url + '/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Lab-Token': boot.token },
          body: JSON.stringify({ revision: state.revision, action, payload }),
        });
        const response = await res.json();
        assert.equal(res.status, 200, JSON.stringify(response));
        state = response.state;
      }
      await cmd('create', { name: 'Culture QA', type: '24孔板', location: '' });
      const cid = state.containers[0].id;
      await cmd('wells', {
        id: cid,
        wells: ['A1'],
        patch: {
          cell: 'Sample QA',
          kind: '细胞系',
          day0: '2020-01-01',
          anchor: '传代',
          medium: { base: 'Synthetic A' },
        },
      });
      await cmd('cryo_setup_preset', {
        device_name: 'Test device',
        use_rack: true,
        rack_name: 'Test rack',
        box_count: 2,
        rows: 3,
        cols: 4,
      });
      const boxes = state.cryo_storage.boxes;
      await cmd('cryo_stock_create', {
        name: 'Blank QA',
        at: '2020-01-02',
        storage_stage: 'stored',
        vials: 1,
        placements: [{ box_id: boxes[0].id, slot: 'B1' }],
      });
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.LAB_NOTE_BROWSER_EXECUTABLE,
        args: ['--no-proxy-server'],
      });
      const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(10000);
      await page.goto(url);
      await page.click('[data-view="cryo"]');
      const slot = (name) => page.locator('[data-cryo-slot="' + name + '"]');
      async function save(button) {
        const wait = page.waitForResponse((r) => r.url().endsWith('/api/command'));
        await button.click();
        const res = await wait,
          data = await res.json();
        assert.equal(res.status(), 200, JSON.stringify(data));
        state = data.state;
        await page.waitForFunction(() => !busy);
        return data.state;
      }
      // Drag to choose empty slots, retain draft values across renders, and save/reapply a template.
      const form = page.locator('#cryo-inline-stock-form');
      const field = (n) => form.locator('[name="' + n + '"]');
      page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'QA template' : undefined));
      let from = await slot('A1').boundingBox(),
        to = await slot('A3').boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
      await page.mouse.up();
      assert.equal(await page.locator('.cryo-slot.is-selected').count(), 3);
      await field('name').fill('Sample QA');
      await field('cryo_source').selectOption({ index: 1 });
      await field('subclone').fill('Original');
      await field('count_coeff').fill('7');
      await field('count_exp').fill('0');
      await field('count_unit').fill('count QA');
      await form.locator('[data-res-input]').fill('Tag One');
      await form.locator('[data-res-input]').press('Enter');
      await field('name').press('Enter');
      await slot('A4').click();
      assert.equal(await field('name').inputValue(), 'Sample QA');
      assert.notEqual(await field('cryo_source').inputValue(), '');
      assert.equal(await page.evaluate(() => state.frozen_batches.length), 1);
      await save(page.locator('[data-save-tpl]'));
      assert.equal(state.cryo_storage.templates.length, 1);
      assert.equal(state.cryo_storage.templates[0].subclone, 'Original');
      await field('name').fill('replaced');
      await field('count_exp').fill('2');
      await page.locator('[data-apply-tpl]').click();
      assert.equal(await field('name').inputValue(), 'Sample QA');
      assert.equal(await field('count_exp').inputValue(), '0');
      assert.equal(await field('count_unit').inputValue(), 'count QA');
      // Generate three independent clone records, filter the map, and correct one slot.
      await slot('A4').click();
      await field('subclone_seq_on').check();
      await field('subclone_seq_prefix').fill('QA-');
      await field('subclone_seq_start').fill('4');
      assert.match(await page.locator('[data-seq-preview]').innerText(), /A3 → QA-6/);
      await save(form.locator('button[type=submit]'));
      assert.deepEqual(
        state.frozen_batches.filter((l) => l.subclone).map((l) => l.subclone),
        ['QA-4', 'QA-5', 'QA-6'],
      );
      assert.equal(state.frozen_batches.at(-1).sources[0].id, cid);
      assert.match(await slot('A1').getAttribute('class'), /is-low-stock/);
      await page.locator('[data-facet-res="tag one"]').click();
      assert.match(await slot('B1').getAttribute('class'), /is-dim/);
      await page.locator('#cryo-low-stock-toggle').click();
      assert.match(await slot('A1').getAttribute('class'), /is-match/);
      await page.locator('#cryo-clear-filters').click();
      await slot('A4').click();
      await save(page.locator('[data-del-tpl]'));
      assert.equal(state.cryo_storage.templates.length, 0);
      await slot('A1').click();
      await save(page.locator('#cryo-slot-delete'));
      assert.ok(!state.cryo_storage.boxes[0].slots.A1);
      assert.ok(!(state.frozen_withdrawals || []).some((w) => w.contamination));
      await slot('A1').click();
      await slot('A4').click();
      await slot('B2').click();
      await field('name').fill('Sample QA');
      await field('at').fill('2020-02-01');
      await field('cryo_source').selectOption({ index: 1 });
      await save(form.locator('button[type=submit]'));
      // A three-vial lot supports separate thaw, discard and verification records.
      const group = state.frozen_batches.at(-1);
      assert.doesNotMatch(await slot('A1').getAttribute('class'), /is-low-stock/);
      await slot('A1').click();
      await page.locator('#cryo-slot-thaw').click();
      const removal = page.locator('#cryo-discard-form');
      assert.equal(await removal.locator('[data-medium-field=base]').inputValue(), 'Synthetic A');
      await removal.locator('[data-medium-field=base]').fill('Synthetic B');
      await save(removal.locator('button[type=submit]'));
      assert.equal(state.frozen_withdrawals.at(-1).medium.base, 'Synthetic B');
      const cleanId = state.frozen_withdrawals.at(-1).id;
      await slot('A4').click();
      await page.locator('#cryo-slot-discard').click();
      assert.ok(await removal.locator('[name=discard_mode][value=plain]').isChecked());
      await removal.locator('[name=discard_mode][value=contamination]').check();
      await save(removal.locator('button[type=submit]'));
      assert.ok(state.frozen_withdrawals.at(-1).contamination);
      await slot('B2').click();
      await page.locator('[data-open-clear-yellow]').click();
      const clear = page.locator('#cryo-clear-yellow-form');
      assert.equal(await clear.locator('[name=withdrawal_id]').inputValue(), cleanId);
      await clear.locator('[name=notes]').fill('QA review');
      await save(clear.locator('button[type=submit]'));
      assert.equal(
        state.frozen_withdrawals.at(-1).contamination.cleared_by_clean_thaw.withdrawal_id,
        cleanId,
      );
      assert.equal(
        state.frozen_withdrawals.find((w) => w.id === cleanId).clean_verification.notes,
        'QA review',
      );
      await page.locator('[data-cryo-tab=batches]').click();
      await page.locator('[data-batch-card="' + group.id + '"] summary').click();
      assert.match(await page.locator('[data-batch-card="' + group.id + '"]').innerText(), /QA review/);
      await page.locator('[data-cryo-tab=map]').click();
      await page.locator('#cryo-slot-thaw').click();
      await removal.locator('[name=apply_medium]').uncheck();
      await save(removal.locator('button[type=submit]'));
      assert.equal(state.frozen_withdrawals.at(-1).medium, undefined);
      const popup = page.waitForEvent('popup');
      await page.locator('#cryo-print-box').click();
      const print = await popup;
      await print.waitForLoadState();
      await print.evaluate(() => {
        window.print = () => {
          window.printed = true;
        };
      });
      await print.locator('#print-now-btn').click();
      assert.equal(await print.evaluate(() => window.printed), true);
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      server.kill();
      await stopped;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
