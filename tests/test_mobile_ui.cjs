const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const origin = 'https://lab-note.example';
const source = fs.readFileSync(path.join(__dirname, '../app/static/sw.js'), 'utf8');

function worker() {
  const handlers = {};
  const saved = new Map();
  const cache = {
    put: async (key, response) => saved.set(key, response),
    match: async key => saved.get(key),
  };
  let reply;
  vm.runInNewContext(source, {
    URL, Response,
    self: {location: {origin}, addEventListener: (event, handle) => { handlers[event] = handle; }},
    caches: {open: async () => cache},
    fetch: async () => {
      if (!reply) throw Error('offline');
      return reply;
    },
  });
  return {
    saved,
    fetch(name, options = {}) {
      const request = {url: origin + name, method: 'GET', mode: 'same-origin', headers: new Headers(), ...options};
      let response;
      handlers.fetch({request, respondWith: value => { response = value; }});
      return response;
    },
    setReply(value) { reply = value; },
  };
}

test('the worker ignores document, device, API and non-asset requests', () => {
  const w = worker();
  for (const name of ['/', '/index.html', '/pair', '/api/state', '/devices', '/devices/qr.js',
    '/devices/ca.cer', '/devices.css', '/devices.js', '/app.js?token=sample', '/app.js?v=123456789abc&other=1']) {
    assert.equal(w.fetch(name), undefined, name);
  }
  for (const options of [{method: 'POST'}, {mode: 'navigate'}, {url: 'https://other.example/app.js'},
    {headers: new Headers({'X-Lab-Token': 'sample'})}, {headers: new Headers({Authorization: 'sample'})}]) {
    assert.equal(w.fetch('/app.js', options), undefined);
  }
});

test('only exact, direct static assets can populate the offline cache', async () => {
  const w = worker();
  const name = '/app.js?v=123456789abc';
  function reply(type, overrides = {}) {
    const body = new Response('sample source', {headers: {'Content-Type': type, 'X-Demo-Header': 'sample'}});
    return {
      status: 200, url: origin + name, type: 'basic', redirected: false, headers: body.headers,
      clone: () => body.clone(), ...overrides,
    };
  }
  for (const response of [
    reply('text/html'), reply('application/json'), reply('text/javascript', {status: 401}),
    reply('text/javascript', {redirected: true}), reply('text/javascript', {url: origin + '/pair'}),
  ]) {
    w.setReply(response);
    assert.equal(await w.fetch(name), response);
    assert.equal(w.saved.size, 0);
  }
  const good = reply('text/javascript; charset=utf-8');
  w.setReply(good);
  assert.equal(await w.fetch(name), good);
  assert.deepEqual([...w.saved.keys()], [origin + name]);
  w.setReply(null);
  const offline = await w.fetch(name);
  assert.equal(await offline.text(), 'sample source');
  assert.equal(offline.headers.get('X-Demo-Header'), null);
  await assert.rejects(w.fetch('/app.js?v=123456789abd'), /offline/);
});
