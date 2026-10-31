import test from 'node:test';
import assert from 'node:assert/strict';
import { Matcher, INDEX_STATUS_KEY, SwarmClient, serverUrl, permissionOrigin, MATCH_ROUTE } from '../lib/swarm.js';

const items = [{ modelId: 42, modelVersionId: 100, modelType: 'Checkpoint', publishedAt: 1000 }];
const reply = (items, status = 'downloaded', indexState = 'ready') => ({ schemaVersion: 1, indexState, indexRevision: 'same-revision',
  coverage: { localFiles: 4, identifiedFiles: 3, unresolvedFiles: 1 },
  results: items.map(item => ({ modelId: item.modelId, modelVersionId: item.modelVersionId, status,
    ownedVersionIds: [100], privatePath: 'not-for-content' })) });

test('server URL supports Text2Image and proxy prefixes without URL credentials', () => {
  assert.equal(serverUrl('ai-desktop:7801/Text2Image#history').href, 'http://ai-desktop:7801/');
  assert.equal(serverUrl('https://swarm.test/proxy/Text2Image?x=1').href, 'https://swarm.test/proxy/');
  assert.equal(permissionOrigin('http://ai-desktop:7801'), 'http://ai-desktop:7801/*');
  assert.throws(() => serverUrl('https://user:password@swarm.test'));
});

test('batch client uses only session/matching APIs, sends units intact, and renews one expired session', async () => {
  const calls = [];
  let sessions = 0;
  const client = new SwarmClient({ fetch: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error');
    if (url.endsWith('GetNewSession')) return Response.json({ session_id: `s${++sessions}` });
    assert.ok(url.endsWith(MATCH_ROUTE)); if (body.items.length) assert.deepEqual(body.items, items);
    if (body.session_id === 's1') return Response.json({ error_id: 'invalid_session_id' }, { status: 401 });
    return Response.json(reply(body.items));
  } });
  const response = await client.match('https://swarm.test/proxy/Text2Image', items);
  assert.equal(sessions, 2);
  assert.equal(response.results[0].status, 'downloaded');
  assert.equal(response.results[0].privatePath, undefined);
  assert.ok(calls.every(call => call.url.startsWith('https://swarm.test/proxy/API/')));
  await client.match('https://swarm.test/proxy', []);
  assert.equal(sessions, 2);
});

test('missing endpoint explains extension requirement with no inventory or Civitai fallback', async () => {
  const calls = [];
  const client = new SwarmClient({ fetch: async url => { calls.push(url); return url.endsWith('GetNewSession')
    ? Response.json({ session_id: 's' }) : Response.json({ error_id: 'bad_route', error: 'Unknown API route.' }); } });
  await assert.rejects(client.match('http://swarm.test', items), /Update WhatTheDuck/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => !url.includes('ListModels') && !url.includes('civitai')));
});

test('missing, misordered, unsupported statuses and schema mismatch fail closed', async () => {
  for (const malformed of [{ ...reply(items), results: [] }, { ...reply(items), schemaVersion: 2 },
    { ...reply(items), results: [{ modelId: 43, modelVersionId: 100, status: 'downloaded' }] }, reply(items, 'not_downloaded')]) {
    const client = new SwarmClient({ fetch: async url => Response.json(url.endsWith('GetNewSession') ? { session_id: 's' } : malformed) });
    await assert.rejects(client.match('http://swarm.test', items), /invalid|mismatched/);
  }
});

test('partial results remain usable; unavailable index always returns unknown', async () => {
  for (const state of ['ready', 'partial', 'unavailable']) {
    const client = new SwarmClient({ fetch: async url => Response.json(url.endsWith('GetNewSession') ? { session_id: 's' } : reply(items, 'downloaded', state)) });
    const result = await client.match('http://swarm.test', items);
    assert.equal(result.indexState, state);
    assert.equal(result.results[0].status, state === 'unavailable' ? 'unknown' : 'downloaded');
  }
});

test('501 items are rejected before network access', async () => {
  const client = new SwarmClient({ fetch: () => assert.fail('No network expected') });
  await assert.rejects(client.match('http://swarm.test', Array(501).fill(items[0])), /500/);
});

function harness() {
  const data = { targetUrl: 'http://swarm.test' };
  let time = 1_000_000;
  let calls = 0;
  let status = 'downloaded';
  let error;
  const matcher = new Matcher({ storage: {
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])),
    set: async value => Object.assign(data, value)
  }, permissions: { contains: async () => true }, now: () => time,
  client: { clear() {}, match: async (target, input) => { calls++; if (error) throw new Error(error); return reply(input, status); } } });
  return { matcher, data, calls: () => calls, advance: ms => { time += ms; }, fail: () => { error = 'offline'; }, status: value => { status = value; } };
}

test('coalesces repeats but re-queries unchanged revision after short TTL', async () => {
  const h = harness();
  await Promise.all([h.matcher.match(items), h.matcher.match(items)]);
  assert.equal(h.calls(), 1);
  h.status('unknown');
  h.advance(30_000);
  const response = await h.matcher.match(items);
  assert.equal(h.calls(), 2);
  assert.equal(response.indexRevision, 'same-revision');
  assert.equal(response.results[0].status, 'unknown');
  assert.equal(h.data[INDEX_STATUS_KEY].results, undefined);
});

test('offline response removes positive statuses; no persistent ownership cache', async () => {
  const h = harness();
  await h.matcher.match(items);
  h.advance(30_000); h.fail();
  const response = await h.matcher.match(items);
  assert.equal(response.indexState, 'unavailable');
  assert.equal(response.results[0].status, 'unknown');
  assert.equal(h.data[INDEX_STATUS_KEY].error, 'offline');
});

test('server changes during request discard the old response and do not overwrite status', async () => {
  const h = harness();
  h.matcher.client.match = async () => { h.data.targetUrl = 'http://other.test'; return reply(items); };
  const response = await h.matcher.match(items);
  assert.equal(response.results[0].status, 'unknown');
  assert.match(response.error, /server changed/);
  assert.equal(h.data[INDEX_STATUS_KEY], undefined);
});

test('revoked permission invalidates even a fresh successful batch', async () => {
  const h = harness();
  await h.matcher.match(items);
  h.matcher.permissions.contains = async () => false;
  const response = await h.matcher.match(items);
  assert.equal(response.results[0].status, 'unknown');
  assert.match(response.error, /allow access/);
  assert.equal(h.calls(), 1);
});
