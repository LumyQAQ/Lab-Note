const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {test} = require('node:test');
const assert = require('node:assert/strict');

test('related positions exclude every selection, retain all siblings and navigate across boxes', {
  skip: process.env.LAB_NOTE_BROWSER_TEST !== '1' && 'Set LAB_NOTE_BROWSER_TEST=1 to run',
  timeout: 120000,
}, async () => {
  const {chromium} = require('playwright-core');
  const cwd = process.env.LAB_NOTE_APP_ROOT || path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-relations-qa-'));
  const ready = path.join(dir, 'ready.json');
  const server = spawn(process.env.LAB_NOTE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['-B', cwd + '/app/server.py', '--data-dir', dir, '--port', 'auto', '--ready-file', ready],
    {cwd, stdio:['ignore', 'ignore', 'pipe']});
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
      const res = await fetch(url + '/api/command', {method:'POST',
        headers:{'Content-Type':'application/json', 'X-Lab-Token':boot.token},
        body:JSON.stringify({revision:state.revision, action, payload})});
      const data = await res.json();
      assert.equal(res.status, 200, JSON.stringify(data));
      state = data.state;
    }
    await cmd('cryo_setup_preset', {device_name:'Relations QA',box_count:2,rows:3,cols:5});
    const [box, second] = state.cryo_storage.boxes;
    const base = {name:'Synthetic relation QA',at:'2020-01-01',subclone:'Clone-A',
      special_treatments:['GFP'],resistance_tags:['Puro'],source_subject:'Synthetic subject',storage_stage:'stored'};
    const slots = ['A1','A2','A3','A4','A5','B1','B2'];
    await cmd('cryo_stock_create', {...base,vials:8,placements:[
      ...slots.map(slot=>({box_id:box.id,slot})),{box_id:second.id,slot:'A1'}]});
    const anchorId = state.frozen_batches.at(-1).id;
    await cmd('cryo_stock_create', {...base,vials:2,placements:[{box_id:box.id,slot:'B4'},{box_id:box.id,slot:'B5'}]});
    await cmd('cryo_stock_create', {...base,vials:1,subclone:'Clone-B',placements:[{box_id:box.id,slot:'C1'}]});
    await cmd('cryo_stock_create', {...base,vials:1,special_treatments:['Other'],placements:[{box_id:box.id,slot:'C2'}]});
    await cmd('cryo_stock_create', {...base,vials:1,special_treatments:['Other'],resistance_tags:[],placements:[{box_id:box.id,slot:'C3'}]});
    await cmd('cryo_stock_create', {...base,vials:1,sample_category:'protein',name:'Synthetic protein QA',placements:[{box_id:box.id,slot:'C4'}]});
    browser = await chromium.launch({headless:true,executablePath:process.env.LAB_NOTE_BROWSER_EXECUTABLE,args:['--no-proxy-server']});
    const page = await browser.newPage({viewport:{width:1440,height:980}});
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', e=>errors.push(e.message));
    await page.goto(url);
    await page.click('[data-view="cryo"]');
    await page.locator(`[data-select-box="${box.id}"]`).click();
    const slot = key=>page.locator(`[data-cryo-slot="${key}"]`);
    await slot('A1').click();
    const related = page.locator('.cryo-related-panel:not(.cryo-cross-panel)');
    const tiers = related.locator('.cryo-related-tier');
    assert.match(await tiers.nth(0).innerText(), /另有 9 支/);
    assert.match(await tiers.nth(1).innerText(), /同日不同亚克隆[\s\S]*另有 1 支/);
    assert.match(await tiers.nth(2).innerText(), /共享特殊处理或抗性[\s\S]*另有 1 支/);
    assert.equal(await tiers.nth(0).locator('[data-jump-slot]').count(), 9, 'Every sibling position has a button, including positions beyond six');
    assert.equal(await related.locator(`[data-jump-box="${box.id}"][data-jump-slot="A1"]`).count(), 0);
    assert.equal(await related.locator('[data-jump-slot="C3"]').count(), 0, 'Unrelated treatment is excluded');
    assert.equal(await related.locator('[data-jump-slot="C4"]').count(), 0, 'Protein never joins cell tiers');
    assert.equal(await page.locator('.cryo-cross-panel li').count(), 1);
    assert.match(await page.locator('.cryo-cross-panel').innerText(), /Synthetic protein QA/);
    await slot('A2').click();
    assert.match(await tiers.nth(0).innerText(), /另有 8 支/);
    assert.equal(await related.locator(`[data-jump-box="${box.id}"][data-jump-slot="A2"]`).count(), 0);
    await slot('B4').click({modifiers:['Shift']});
    assert.match(await tiers.nth(0).innerText(), /另有 7 支/);
    assert.equal(await related.locator('[data-jump-slot="B4"]').count(), 0);
    assert.equal(await related.locator('[data-jump-slot="B5"]').count(), 1);
    await related.locator(`[data-jump-box="${second.id}"][data-jump-slot="A1"]`).click();
    assert.equal(await page.locator('[data-cryo-slot="A1"].is-selected').count(), 1);
    assert.match(await page.locator('#cryo-inspector').innerText(), new RegExp(second.name));
    await page.locator('[data-cryo-tab="batches"]').click();
    const card = page.locator(`[data-batch-card="${anchorId}"]`);
    await card.locator('summary').click();
    const text = await card.innerText();
    assert.match(text, /本批剩 8 支 · 其他关联余量：强相关（同日同组同克隆）2 支/);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server.exitCode === null) server.kill('SIGTERM');
    await stopped;
    fs.rmSync(dir, {recursive:true,force:true});
  }
});
