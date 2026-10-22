import test from 'node:test';
import assert from 'node:assert/strict';
import { officialRequest, nxtvProgrammes, xjtvsProgrammes } from '../src/official.js';

test('official HTTP requests retain caller authentication while supplying web-compatible defaults', async () => {
  assert.equal(await officialRequest('https://example.test/', {
    method: 'POST', body: '{}', headers: { Authorization: 'fixture', 'Content-Type': 'application/json' },
    fetchImpl: async (_url, init) => {
      assert.match(init.headers['User-Agent'], /Mozilla/);
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
    assert.equal(init.headers.Origin, 'https://www.nxtv.cn');
    return Response.json({ errcode: 200, data: { appid: 'nxtv-tv', menu: [{ ename: 'nxgg', playbill: [] }] } });
  } });
  await xjtvsProgrammes('3', '2026-10-22', { fetchImpl: async (_url, init) => {
    assert.equal(init.headers.Referer, 'https://www.xjtvs.com.cn/');
    return Response.json({ success: true, data: [] });
  } });
});
