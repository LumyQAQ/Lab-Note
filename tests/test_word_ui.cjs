const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('Word exports saved records, protects unsaved edits and manages local templates', {
  skip: process.env.LAB_NOTE_BROWSER_TEST !== '1' && 'Set LAB_NOTE_BROWSER_TEST=1 to run the browser suite', timeout: 90000,
}, async () => {
  const { chromium } = require('playwright-core');
  const cwd = process.env.LAB_NOTE_APP_ROOT || path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labnote-word-ui-'));
  const ready = path.join(dir, 'ready.json');
  const server = spawn(process.env.LAB_NOTE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['-B', path.join(cwd, 'app/server.py'), '--data-dir', dir, '--port', 'auto', '--ready-file', ready], { cwd, stdio: ['ignore','ignore','inherit'] });
  const stopped = once(server, 'exit');
  let browser;
  try {
    for(let i=0;i<300&&!fs.existsSync(ready)&&server.exitCode===null;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const url='http://127.0.0.1:'+JSON.parse(fs.readFileSync(ready)).port;
    const boot=await (await fetch(url+'/api/state')).json();
    const response=await fetch(url+'/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Token':boot.token},body:JSON.stringify({revision:boot.state.revision,action:'lab_record_save',payload:{type:'flow',variant:'assay',title:'Synthetic Word QA',record_date:'2026-01-01',status:'draft',data:{},tables:{},notes:'Saved QA content',files:[],cell_sources:[],record_refs:[]}})});
    const saved=await response.json();assert.equal(response.status,200,JSON.stringify(saved));
    const id=saved.state.lab_records.at(-1).id;
    browser=await chromium.launch({headless:true,executablePath:process.env.LAB_NOTE_BROWSER_EXECUTABLE,args:['--no-proxy-server']});
    const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(url);
    await page.locator('#home-create').waitFor();await page.evaluate(id=>openLabRecord(id),id);
    const picker=page.locator('[data-word-tpl-select]');await picker.waitFor();assert.ok(await picker.locator('option').count()>=3);
    await page.locator('[data-lab-common=notes]').fill('Unsaved QA content');
    await page.locator('[data-word-download]').click();assert.match(await page.locator('[data-word-error]').innerText(),/未保存/);
    await page.locator('[data-lab-common=notes]').fill('Saved QA content');
    const download=page.waitForEvent('download');await page.locator('[data-word-download]').click();
    const document=await download;assert.match(document.suggestedFilename(),/\.docx$/);const file=await document.path();assert.equal(fs.readFileSync(file).subarray(0,2).toString(),'PK');
    assert.equal(await page.locator('[data-word-edition]').count(),1);
    await page.locator('#lab-close').click();await page.locator('[data-view=backup]').click();await page.locator('.word-tpl-item').first().waitFor();
    await page.locator('#edit-backup-dir').click();assert.ok(await page.locator('#backup-dir-editor').isVisible());await page.locator('#cancel-backup-dir').click();
    const blankDownload=page.waitForEvent('download');await page.locator('.word-tpl-item a').first().click();const blank=await blankDownload;
    await page.locator('#word-tpl-name').fill('Synthetic imported template');await page.locator('#word-tpl-file').setInputFiles({name:'qa-template.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:fs.readFileSync(await blank.path())});await page.locator('#word-tpl-submit').click();
    await page.getByText('Synthetic imported template',{exact:true}).waitFor();
    assert.deepEqual(errors,[]);
  } finally {if(browser)await browser.close();server.kill();await stopped;fs.rmSync(dir,{recursive:true,force:true});}
});
