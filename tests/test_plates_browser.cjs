const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('normal plate UI creates Transwell and organoid drafts from actual saved layouts', {
  skip: process.env.LAB_NOTE_BROWSER_TEST !== '1' && 'Set LAB_NOTE_BROWSER_TEST=1 to run', timeout:90000,
}, async () => {
  const { chromium } = require('playwright-core');
  const cwd=process.env.LAB_NOTE_APP_ROOT || path.resolve(__dirname,'..');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'labnote-plates-'));
  const ready=path.join(directory,'ready.json');
  const server=spawn(process.env.LAB_NOTE_PYTHON || 'python3',['-B',path.join(cwd,'app/server.py'),'--data-dir',directory,'--port','auto','--ready-file',ready],{cwd,stdio:['ignore','ignore','inherit']});
  const stopped=once(server,'exit');
  let browser;
  try {
    for(let i=0;i<300&&!fs.existsSync(ready)&&server.exitCode===null;i++)await new Promise(resolve=>setTimeout(resolve,50));
    const url='http://127.0.0.1:'+JSON.parse(fs.readFileSync(ready)).port;
    browser=await chromium.launch({headless:true,executablePath:process.env.LAB_NOTE_BROWSER_EXECUTABLE,args:['--no-proxy-server']});
    const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    for(const [type,kind,name] of [['Transwell 6孔板','transwell','Synthetic TW'],['低吸附U底96孔板','organoid','Synthetic ORG']]) {
      await page.locator('[data-view="today"]').click();
      await page.locator('#add-container').click();
      await page.locator('#create-form [name="name"]').fill(name);
      await page.locator('#container-type').selectOption(type);
      await page.locator('#create-form [type="submit"]').click();
      await page.locator('#deselect').click();
      await page.locator('#detail [data-well="A1"]').click();
      await page.locator('#plate-contents-kind').selectOption(kind);
      if(kind==='transwell') {
        await page.locator('#plate-tw-upper-cell').fill('Synthetic upper');
        await page.locator('#plate-tw-upper-vol').fill('100');
        await page.locator('#plate-tw-lower-medium').fill('Synthetic lower');
      } else {
        await page.locator('#plate-org-name').fill('Synthetic model');
        await page.locator('#plate-org-dome-vol').fill('20');
        await page.locator('#plate-effector-cell').fill('Synthetic effector');
      }
      await page.locator('#save-plate-contents').click();
      await page.waitForFunction(({kind})=>state.containers.find(c=>c.id===currentId).wells.A1.assay_contents?.kind===kind,{kind});
      await page.locator('#plate-today-open').click();
      await page.locator('#plate-today-dialog [name="kind"]').selectOption(kind==='transwell'?'transwell':'organoid/coculture');
      await page.locator('#plate-today-save').click();
      await page.locator('#lab-record-dialog[open]').waitFor();
      const table=kind==='transwell'?'chamber_groups':'plating_groups';
      assert.equal(await page.locator(`[data-lab-table="${table}"]`).count(),1);
      const field=kind==='transwell'?'upper_cell':'organoid';
      assert.equal(await page.locator(`[data-lab-column="${field}"]`).inputValue(),kind==='transwell'?'Synthetic upper':'Synthetic model');
      const method=kind==='transwell'?'seeding_protocol':'dissociation_embedding_steps';
      assert.equal(await page.locator(`[data-lab-field="${method}"]`).inputValue(),'');
      await page.locator('[data-lab-add-row="results"]').click();
      assert.ok(await page.locator('[data-lab-table="results"] [data-unit-choice]').count());
      await page.locator('#lab-save').click();
      await page.locator('#lab-record-dialog').waitFor({state:'hidden'});
    }
    const boot=await(await fetch(url+'/api/state')).json();
    assert.equal(boot.state.lab_records.length,2);
    assert.ok(boot.state.lab_records.every(record=>record.plate_context));
    await page.evaluate(async()=>{
      await command('create',{name:'Synthetic tracked cells',type:'24孔板'});
      await command('wells',{id:state.containers.at(-1).id,wells:['A1'],patch:{cell:'Synthetic cells',kind:'细胞系',day0:boot.today,anchor:'传代'}});
    });
    await page.locator('[data-view="work"]').click();
    for(const name of ['Synthetic TW','Synthetic ORG']) {
      const card=page.locator('.work-container').filter({has:page.getByRole('heading',{name,exact:true})});
      await card.getByText('无需培养核对',{exact:true}).waitFor();
      assert.equal(await card.getByText('无需培养核对',{exact:true}).count(),1);
      assert.equal(await card.locator('[data-work-check]').count(),0);
    }
    const tracked=page.locator('.work-container').filter({has:page.getByRole('heading',{name:'Synthetic tracked cells',exact:true})});
    assert.ok(await tracked.locator('[data-work-check]').isEnabled());
    assert.equal(await page.locator('.work-container').first().locator('h3').innerText(),'Synthetic tracked cells');
    assert.deepEqual(errors,[]);
  } finally {
    if(browser)await browser.close();
    server.kill();await stopped;fs.rmSync(directory,{recursive:true,force:true});
  }
});
