// Exercise the public transfer editor with synthetic plate coordinates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ctx = vm.createContext({
  boot: {layouts: {'48孔板': [6, 8], '24孔板': [4, 6]}, types: ['48孔板', '24孔板', 'T25']},
  state: {containers: []},
  structuredClone,
  busy: false,
  current: () => null,
  document: {querySelectorAll: () => []},
  $: () => null,
  toast() {},
});
for (const file of ['groups', 'transfer', 'transfer-cards', 'occupied-targets', 'replate']) {
  const source = fs.readFileSync(path.join(__dirname, '../app/static', file + '.js'), 'utf8');
  vm.runInContext(source, ctx);
}
vm.runInContext('renderTransfer = () => {}; promptOccupiedSelection = () => {}', ctx);
const before = ['B2', 'B3', 'C2', 'C3'];
const after = ['D5', 'D6', 'D7', 'E5', 'E6', 'E7'];
const source = {id: 'source', type: '48孔板', status: 'active', wells: {}};
for (const well of [...before, ...after]) source.wells[well] = {cell: 'Sample ' + well};
ctx.state.containers.push(source);
const key = well => ctx.sourceKey(source.id, well);
const draft = {
  mode: 'replate', sources: {}, targets: [], endSources: [], newContainers: [],
};
for (const well of before) draft.sources[key(well)] = {id: source.id, well};
ctx.fixture = draft;
vm.runInContext('transferDraft = fixture', ctx);
ctx.addTransferContainer('48孔板', 'Layout');
ctx.initializeReplate();
const first = draft.targets[0];
ctx.updateTransferTarget(first.ref, {type: '24孔板'});
assert.deepEqual(Array.from(first.wells), before);
first.locked = true;

// Both entry points offer only the still unassigned source wells.
ctx.addNewTransferDestination();
const plus = draft.targets[1];
assert.equal(ctx.transferTarget(plus.ref).type, '24孔板');
assert.deepEqual(Array.from(ctx.replateCellSourceOptions(plus), s => s.well), after);
draft.targets.pop();
ctx.pruneTransferTargets();
ctx.addReplateCellGroup(0, null, {newPlate: true});
const second = draft.targets[1];
assert.notEqual(second.ref, first.ref);
assert.equal(ctx.transferTarget(second.ref).type, '24孔板');
ctx.setTransferTargetSourceSelection(1, new Set(after.map(key)));
const mapped = () => Array.from(ctx.replatePairs(second), p => p.source.well + '>' + p.well);
const expected = ['D5>C4', 'D6>C5', 'D7>C6', 'E5>D4', 'E6>D5', 'E7>D6'];
assert.deepEqual(mapped(), expected);

// An overlapping target selection still translates the entire source pattern.
ctx.setReplateTargetWells(second, []);
ctx.setReplateTargetWells(second, ['D6', 'D5', 'C5', 'C6', 'D4', 'C4']);
assert.deepEqual(mapped(), expected);
second.anchorPlaceMode = true;
ctx.placeReplateAtAnchor(1, 'D5');
assert.equal(second.anchorPlaceMode, true);
assert.deepEqual(mapped(), expected);
ctx.placeReplateAtAnchor(1, 'B2');
assert.equal(second.anchorPlaceMode, false);
assert.deepEqual(mapped(), ['D5>B2', 'D6>B3', 'D7>B4', 'E5>C2', 'E6>C3', 'E7>C4']);

// A sparse pattern retains its gaps. An oversized group needs manual placement.
second.sourceKeys = ['D5', 'E7'].map(key);
assert.deepEqual(Array.from(ctx.replateAutoRelativePlacement(second, ctx.transferTarget(second.ref)).wells), ['C4', 'D6']);
for (const well of ['A1', 'F8']) {
  source.wells[well] = {cell:'Example'};
  draft.sources[key(well)] = {id:source.id, well};
}
assert.equal(ctx.replateAutoRelativePlacement({...second, sourceKeys:['A1','F8'].map(key)}, ctx.transferTarget(second.ref)), null);
console.log('Plate split and relative placement passed.');
