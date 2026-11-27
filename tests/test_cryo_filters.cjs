const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function notebook(state) {
  const ui = vm.createContext({state});
  for (const file of ['autocomplete.js', 'experiments.js', 'cryo-storage.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/static', file), 'utf8'), ui);
  }
  return ui;
}

test('copy colors use content, and searching for WT does not fill missing annotations', () => {
  const ui = notebook({});
  const lot = {id:'original',name:'Sample',special_treatments:[]};
  const copy = {...lot,id:'copy',labels:'tube 2'};
  const edited = {...copy,passage:'P2'};
  const explicit = {...copy,special_treatments:['WT']};
  assert.equal(ui.cryoLotToneKey(copy), ui.cryoLotToneKey(lot));
  assert.notEqual(ui.cryoLotToneKey(edited), ui.cryoLotToneKey(lot));
  assert.notEqual(ui.cryoLotToneKey(explicit), ui.cryoLotToneKey(lot));
  assert.ok(ui.cryoTreatmentFacets(lot).has('wt'));
  assert.ok(ui.cryoTreatmentFacets(explicit).has('wt'));
  assert.deepEqual(lot.special_treatments, []);
});

test('linked records use source identities, including grouped wells, instead of a matching sample name', () => {
  const records = [
    {id:'explicit'},
    {id:'group', source_groups:[{sources:[{container_id:'plate', well:'A1'}]}]},
    {id:'other', title:'Sample', cell_sources:[{container_id:'other-plate', well:'A1'}]}
  ];
  const ui = notebook({lab_records: records});
  const lot = {name:'Sample',sources:[{id:'plate',well:'A1'}],experiment_refs:[{id:'explicit'}]};
  assert.deepEqual(Array.from(ui.cryoLinkedExperiments(lot), item=>item.rec.id), ['explicit','group']);
});

test('low stock combines matching labels and donors across lots and excludes empty stock', () => {
  const same = {name: 'Sample', donor: 'Example', subclone: 'A', resistance_tags: ['Tag B', 'Tag A']};
  const lots = [
    {...same, id: 'first', vials: 1},
    {...same, id: 'second', vials: 3, resistance_tags: ['tag a', 'TAG B']},
    {...same, id: 'other', vials: 1, subclone: 'B'},
  ];
  const ui = notebook({frozen_batches: lots, frozen_withdrawals: [{lot_id: 'second', vials: 1}]});
  const totals = ui.cryoStockGroupRemainingMap();
  vm.runInContext('cryoUi.lowStockOnly = true', ui);
  assert.equal(totals.get('first'), 3);
  assert.equal(ui.cryoMatchesLowStock(lots[0], totals), false);
  assert.equal(ui.cryoMatchesLowStock(lots[2], totals), true);
  assert.equal(ui.cryoMatchesResistance(lots[1], 'tag b'), true);
  assert.equal(ui.cryoMatchesResistance(lots[1], '__none__'), false);
});

test('thaw defaults prioritize source snapshots and keep the latest equal-time thaw within fallback tiers', () => {
  const lot = {id:'sample', name:'Example', sources:[{snapshot:{medium:{base:'Earlier'}}}], at:'2020-01-01'};
  const records = [
    {lot_id:'sample', at:'2020-01-02T08:00', mode:'thaw', medium:{base:'Earlier thaw'}},
    {lot_id:'sample', at:'2020-01-02T08:00', mode:'thaw', medium:{base:'Later entry'}},
  ];
  const ui = notebook({frozen_batches:[lot], frozen_withdrawals:records, containers:[]});
  assert.equal(ui.cryoLastMedium(lot).medium.base, 'Earlier');
  const withoutSource = {...lot, sources:[]};
  assert.equal(ui.cryoLastMedium(withoutSource).medium.base, 'Later entry');
  assert.equal(ui.cryoLastMedium({id:'other', name:'Unrelated'}), null);
  ui.state.containers.push({created_at:'2020-01-03', name:'Saved unit', wells:{A1:{cell:'Example', medium:{base:'Latest'}}}});
  assert.equal(ui.cryoLastMedium(lot).medium.base, 'Earlier');
  assert.equal(ui.cryoLastMedium(withoutSource).medium.base, 'Later entry');
  ui.state.frozen_withdrawals = [];
  assert.equal(ui.cryoLastMedium(withoutSource).medium.base, 'Latest');
});

test('only an independent thaw entry can verify a single active warning', () => {
  const lot = {id:'lot',name:'Sample',at:'2020-01-01'};
  const incident = {id:'incident',lot_id:'lot',mode:'thaw',contamination:{at:'2020-01-02'}};
  const clean = {id:'verified',lot_id:'lot',mode:'thaw'};
  const take = {id:'take',lot_id:'lot',mode:'take'};
  const ui = notebook({frozen_batches:[lot],frozen_withdrawals:[incident,clean,take]});
  assert.deepEqual(Array.from(ui.cryoCleanThawCandidatesForYellow('lot'), w=>w.id), ['verified']);
  assert.equal(ui.cryoCanClearYellowWithWithdrawal('take'), false);
  assert.equal(ui.cryoCanClearYellowWithWithdrawal('verified'), true);
  ui.state.frozen_withdrawals.push({...incident,id:'another'});
  assert.equal(ui.cryoCanClearYellowWithWithdrawal('verified'), false);
});

test('relationship tiers isolate categories, subjects and unknown annotations and require shared evidence', () => {
  const ui = notebook({});
  const base = {name:'Sample', sample_category:'cell', at:'2026-11-01', subclone:'A',
    special_treatments:['GFP'], resistance_tags:['Puro'], source_subject:'Subject'};
  const tier = patch => ui.cryoRelationTier(base, {...base, ...patch});
  assert.equal(tier({}), 'strong');
  assert.equal(tier({subclone:'B'}), 'weak');
  assert.equal(tier({at:'2026-11-02'}), 'weak');
  assert.equal(tier({at:'2026-11-02', subclone:'B'}), 'weaker');
  assert.equal(tier({special_treatments:['Other'], resistance_tags:['Puro']}), 'weaker');
  assert.equal(tier({special_treatments:['Other'], resistance_tags:[]}), null);
  assert.equal(tier({sample_category:'protein'}), null);
  assert.equal(tier({source_subject:'Other subject'}), null);
  assert.equal(ui.cryoRelationTier({name:'Sample', special_treatments:[]}, {name:'Sample', special_treatments:['WT']}), null);
  assert.equal(ui.cryoRelationTier({...base,special_treatments:['WT'],resistance_tags:[]},
    {...base,special_treatments:['WT'],resistance_tags:[],subclone:'B',at:'2026-11-02'}), null);
  assert.equal(ui.cryoRelationTier({...base,donor:'Subject',source_subject:''}, {...base,source_subject:'Other subject'}), null);
});

test('related inventory excludes selected positions precisely and batch cards exclude their own lot', () => {
  const base = {name:'Sample',at:'2026-11-01',vials:3};
  const ui = notebook({frozen_batches:[{...base,id:'a'},{...base,id:'b',vials:2}],
    cryo_storage:{boxes:[{id:'box',rows:1,cols:5,slots:{A1:{batch_id:'a'},A2:{batch_id:'a'},A3:{batch_id:'b'}}},
      {id:'other-box',rows:1,cols:2,slots:{A1:{batch_id:'a'},A2:{batch_id:'b'}}}]}});
  const card = ui.cryoRelatedGroups('a');
  assert.deepEqual(Array.from(card.strong, x=>x.lot.id), ['b']);
  vm.runInContext("excluded = new Set(['box|A1', 'box|A3'])", ui);
  const slots = ui.cryoRelatedGroups('a', ui.excluded);
  assert.equal(slots.strong.reduce((n,x)=>n+x.remaining,0), 3);
  assert.deepEqual(Array.from(slots.strong[0].placed, p=>`${p.box.id}|${p.slot}`), ['box|A2','other-box|A1']);
  assert.deepEqual(Array.from(slots.strong[1].placed, p=>`${p.box.id}|${p.slot}`), ['other-box|A2']);
  vm.runInContext("excluded = new Set(['box|A1', 'box|A2', 'other-box|A1'])", ui);
  assert.deepEqual(Array.from(ui.cryoRelatedGroups('a', ui.excluded).strong, x=>x.lot.id), ['b']);
});

test('cross-category inventory does not duplicate cell relations or link cell specimen labels', () => {
  const ui = notebook({frozen_batches:[
    {id:'a',name:'Cell',sample_category:'cell',source_subject:'S',specimen_type:'Label',vials:1},
    {id:'b',name:'Cell 2',sample_category:'cell',source_subject:'S',specimen_type:'Label',vials:1},
    {id:'p',name:'Protein',sample_category:'protein',source_subject:'S',specimen_type:'Label',vials:1},
    {id:'p2',name:'Protein 2',sample_category:'protein',specimen_type:'Label',vials:1},
  ]});
  assert.deepEqual(Array.from(ui.cryoCrossCategoryRelated('a').sameSubject, x=>x.lot.id), ['p']);
  assert.equal(ui.cryoCrossCategoryRelated('a').sameSpecimen.length, 0);
  assert.deepEqual(Array.from(ui.cryoCrossCategoryRelated('p').sameSpecimen, x=>x.lot.id), ['p2']);
  assert.notEqual(ui.cryoStockGroupKey(ui.state.frozen_batches[0]), ui.cryoStockGroupKey(ui.state.frozen_batches[2]));
});
