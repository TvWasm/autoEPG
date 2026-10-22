import test from 'node:test';
import assert from 'node:assert/strict';
import { officialRequest, nxtvProgrammes, xjtvsProgrammes, yntvProgrammes } from '../src/official.js';
import { readFile } from 'node:fs/promises';
import { transportFailure } from '../src/diagnostics.js';

test('official HTTP requests retain caller authentication without changing unrelated provider headers', async () => {
  assert.equal(await officialRequest('https://example.test/', {
    method: 'POST', body: '{}', headers: { Authorization: 'fixture', 'Content-Type': 'application/json' },
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers['User-Agent'], undefined);
      assert.equal(init.headers.Authorization, 'fixture');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.equal(init.body, '{}');
      return new Response('ok');
    },
  }), 'ok');
});

test('official failures expose nested connection codes and server metadata without signed query secrets', async () => {
  await assert.rejects(officialRequest('https://example.test/?token=private', {
    delay: async () => {}, fetchImpl: async () => {
      throw new TypeError('fetch failed', { cause: new AggregateError([
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('unreachable'), { code: 'ENETUNREACH' }),
      ]) });
    },
  }), error => /ETIMEDOUT/.test(error.message) && /ENETUNREACH/.test(error.message) && !error.message.includes('private'));
  await assert.rejects(officialRequest('https://example.test/', {
    delay: async () => {}, fetchImpl: async () => new Response('private response', { status: 403, headers: { Server: 'edge' } }),
  }), error => /HTTP 403 \(server: edge\)/.test(error.message) && !error.message.includes('private response'));
});

test('Ningxia and Xinjiang request their own official website context', async () => {
  await nxtvProgrammes('nxgg', '2026-10-22', { fetchImpl: async (_url, init) => {
    assert.equal(init.headers.Referer, 'https://www.nxtv.cn/');
    assert.match(init.headers['User-Agent'], /Mozilla/);
    assert.equal(init.headers.Origin, 'https://www.nxtv.cn');
    return Response.json({ errcode: 200, data: { appid: 'nxtv-tv', menu: [{ ename: 'nxgg', playbill: [] }] } });
  } });
  await xjtvsProgrammes('3', '2026-10-22', { fetchImpl: async (_url, init) => {
    assert.equal(init.headers.Referer, 'https://www.xjtvs.com.cn/');
    assert.match(init.headers['User-Agent'], /Mozilla/);
    return Response.json({ success: true, data: [] });
  } });
});

test('Yunnan browser network failures fall back to the same official API and retain validation', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/provincial/yntv-dushi.json', import.meta.url), 'utf8'));
  let attempts = 0;
  const options = { yntvPage: { evaluate: async () => { throw new TypeError('Failed to fetch'); } },
    delay: async () => {}, fetchImpl: async (url, init) => {
      attempts++;
      assert.equal(new URL(url).hostname, 'yntv-api.yntv.cn');
      assert.equal(init.headers.Origin, 'https://www.yntv.cn');
      return Response.json(fixture);
    } };
  const rows = await yntvProgrammes('yunnandushi', '2026-10-22', options);
  assert(rows.length > 10);
  assert.equal(attempts, 1);
  await assert.rejects(yntvProgrammes('yunnandushi', '2026-10-22', {
    ...options, fetchImpl: async () => Response.json({ lists: [], streamer: 'wrong channel' }),
  }), /Invalid YNTV/);
  await assert.rejects(yntvProgrammes('yunnandushi', '2026-10-22', {
    ...options, fetchImpl: async () => new Response('', { status: 403 }),
  }), /HTTP 403/);
  assert(transportFailure(new Error('page.evaluate: TypeError: Failed to fetch')));
});
