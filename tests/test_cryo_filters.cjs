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

test('thaw defaults use the latest recorded medium and preserve alternatives at the same time', () => {
  const lot = {id:'sample', name:'Example', sources:[{snapshot:{medium:{base:'Earlier'}}}], at:'2020-01-01'};
  const records = [
    {lot_id:'sample', at:'2020-01-02T08:00', mode:'thaw', medium:{base:'Earlier thaw'}},
    {lot_id:'sample', at:'2020-01-02T08:00', mode:'thaw', medium:{base:'Later entry'}},
  ];
  const ui = notebook({frozen_batches:[lot], frozen_withdrawals:records, containers:[]});
  assert.equal(ui.cryoLastMedium(lot).medium.base, 'Later entry');
  assert.equal(ui.cryoLastMedium({id:'other', name:'Unrelated'}), null);
  ui.state.containers.push({created_at:'2020-01-03', name:'Saved unit', wells:{A1:{cell:'Example', medium:{base:'Latest'}}}});
  assert.equal(ui.cryoLastMedium(lot).medium.base, 'Latest');
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
