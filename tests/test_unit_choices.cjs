// Every new schema field that asks for a unit must expose choices on a blank installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = path.join(__dirname, '../app');
const schema = JSON.parse(fs.readFileSync(path.join(app, 'lab_schemas.json')));
const ui = vm.createContext({esc: String});
for (const file of ['autocomplete.js', 'medium.js', 'experiments.js']) {
  vm.runInContext(fs.readFileSync(path.join(app, 'static', file), 'utf8'), ui);
}
function check(markup, location) {
  assert.match(markup, /<input\b/, location + ' must allow custom text');
  assert.match(markup, /<select data-unit-choice=/, location + ' needs unit choices');
  assert.ok((markup.match(/<option value="[^"]+"/g) || []).length >= 2, location);
}
const needsUnits = f => /(?:^|_)unit$/.test(f.key) || f.label.includes('单位');
for (const [type, module] of Object.entries(schema.modules)) {
  for (const [variant, spec] of Object.entries(module.variants)) {
    ui.record = {type, variant};
    vm.runInContext('labEditor = {record}', ui);
    for (const field of spec.fields.filter(needsUnits)) {
      check(ui.labFormUnitChoice(field, '<input>'), [type, variant, field.key].join('.'));
    }
    for (const table of spec.tables) {
      for (const field of table.columns.filter(needsUnits)) {
        check(ui.labTableControl(table, {row_id: 'test'}, field), [type, variant, table.key, field.key].join('.'));
      }
    }
  }
}
for (const value of ['7.5', '7.5 mL', '7.5μL', '7.5 drops']) {
  assert.equal(ui.quantityWithUnit(value, 'nL', ['mL','μL','nL','L']), '7.5 nL');
}
console.log('All schema unit fields provide editable presets.');
