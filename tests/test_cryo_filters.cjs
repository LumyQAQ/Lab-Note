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
