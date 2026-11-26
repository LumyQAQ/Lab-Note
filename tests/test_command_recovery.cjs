// Run the same command transport used by every form with scripted local-server replies.
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../app/static/app.js'), 'utf8');
const boot = {token:'test', state:{revision:3}};
const body = {action:'rename', revision:1, payload:{id:'A',name:'Draft'}};
const reply = (status, data) => ({ok:status < 400, status, json:async () => data});
const unrelated = {error:'stale', conflict:{level:'unrelated', current_revision:2}};

function transport(responses, confirmed = true) {
  const calls = [];
  const questions = [];
  const sandbox = vm.createContext({
    crypto:{randomUUID},
    confirm:message => { questions.push(message); return confirmed; },
    fetch:async (url, options) => {
      calls.push({url, body:options.body && JSON.parse(options.body)});
      const result = responses.shift();
      assert.ok(result, 'unexpected additional request');
      if (result instanceof Error) throw result;
      return result;
    },
  });
  // Skip application startup and DOM bindings.
  vm.runInContext(app.slice(0, app.indexOf('async function load()')), sandbox);
  sandbox.initial = boot;
  vm.runInContext('boot = initial', sandbox);
  return {send:() => sandbox.api('/api/command',body), calls, questions};
}

test('retry only the server-checked version, preserve the ID and stop on a newer relevant edit', async () => {
  const changed = {level:'scope_changed',current_revision:3,changed_records:[],changed_containers:['A']};
  const flow = transport([reply(409,unrelated),reply(409,{error:'stale',conflict:changed})]);
  await assert.rejects(flow.send(), /A/);
  assert.equal(flow.questions.length,1);
  assert.deepEqual(flow.calls.map(c => c.body.revision),[1,2]);
  assert.equal(flow.calls[1].body.client_request_id,flow.calls[0].body.client_request_id);
  assert.deepEqual(flow.calls[1].body.payload,body.payload);
});

test('cancel keeps the draft and makes no write attempt at the newer version', async () => {
  const flow = transport([reply(409,unrelated)],false);
  await assert.rejects(flow.send(), /stale/);
  assert.equal(flow.calls.length,1);
});

test('unknown result keeps request ID for manual retry and confirms a lost acknowledgement', async () => {
  const lost = new Error('connection closed');
  const flow = transport([lost,lost,lost,lost,lost,
    reply(200,{committed:true}),reply(200,boot)]);
  await assert.rejects(flow.send(), /未能核实/);
  const saved = await flow.send();
  assert.equal(saved.state.revision,3);
  const attempts = flow.calls.filter(c => c.body);
  assert.equal(attempts.length,4);
  assert.equal(new Set(attempts.map(c => c.body.client_request_id)).size,1);
  assert.ok(flow.calls.some(c => c.url.endsWith(attempts[0].body.client_request_id)));
});
