import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decode, extractChannels, request, pngLogo, channelAliases, verifyPngLogos } from '../src/source.js';

const pageBytes = await readFile(new URL('./fixtures/page.pb', import.meta.url));
const programmeBytes = await readFile(new URL('./fixtures/programmes.pb', import.meta.url));

test('decodes real website protobuf responses and discovers 73 channels', () => {
  const channels = extractChannels(decode('PageResponse', pageBytes));
  assert.equal(channels.length, 73);
  assert.equal(channels[0].name, 'CCTV1');
  assert.equal(channels[0].id, 'cctv1');
  assert(channels.every(c => c.logo.endsWith('.png')));
  assert(channels[0].aliases.includes('CCTV-1'));
  assert.equal(channels[0].group, '央视频道');
  assert(channels[0].logo.endsWith('/main/assets/logos/cctv1.png'));
  assert.equal(new URL(channels.find(c => c.id === 'hunanweishi').logo).hostname, 'resources.yangshipin.cn');
  assert.equal(channels.find(c => c.name === '湖南卫视').id, 'hunanweishi');
  assert.equal(channels.find(c => c.name === '湖南卫视').group, '卫视频道');
  assert(channels.some(c => c.name === '湖南卫视'));
  const programmes = decode('ProgrammeResponse', programmeBytes).dataList;
  assert.equal(programmes.length, 39);
  assert.equal(programmes[0].st, 1788884105);
  assert.equal(programmes[0].name, '生活早参考-特别节目(生活圈)2026-246');
});

test('PNG normalization removes the WebP CDN directive without blindly renaming file extensions', () => {
  assert.equal(pngLogo('https://resources.yangshipin.cn/test.png?imageMogr2/format/webp'),
    'https://resources.yangshipin.cn/test.png');
  assert.throws(() => pngLogo('https://example.com/logo.webp'), /PNG/);
  assert.throws(() => pngLogo('file:///logo.png'), /PNG/);
  assert(channelAliases('CCTV16(4K）').includes('CCTV16-4K'));
  assert(channelAliases('中国教育电视台1频道').includes('CETV1'));
});

test('checks real PNG signature, deduplicates shared logos and rejects disguised WebP', async () => {
  let count = 0;
  const channels = [{ logo: 'https://example.com/a.png' }, { logo: 'https://example.com/a.png' }];
  await verifyPngLogos(channels, {
    fetchImpl: async (url, init) => {
      count++;
      assert.equal(init.headers.Range, 'bytes=0-7');
      assert.equal(init.headers.Referer, undefined);
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    },
  });
  assert.equal(count, 1);
  await assert.rejects(verifyPngLogos(channels, {
    fetchImpl: async () => new Response('RIFFwebp'), delay: async () => {},
  }), /not PNG/);
});

test('bundled CCTV logos pass checksum and PNG validation without fetching upstream copies', async () => {
  const channels = extractChannels(decode('PageResponse', pageBytes))
    .filter(c => new URL(c.logo).hostname === 'raw.githubusercontent.com');
  assert.equal(channels.length, 34);
  assert.equal(await verifyPngLogos(channels, {
    fetchImpl: async () => { throw new Error('Project logos should be verified from the checkout'); },
  }), 33);
});

test('rejects corrupt/truncated protobuf, non-200 API codes, and missing channels', () => {
  assert.throws(() => decode('PageResponse', Buffer.from('<html>error</html>')));
  assert.throws(() => decode('PageResponse', pageBytes.subarray(0, 40)));
  assert.throws(() => decode('ProgrammeResponse', Buffer.from([8, 0])), /Upstream code/);
  assert.throws(() => extractChannels({}), /No TV channels/);
});

test('retries transient HTTP errors with bounded backoff and decodes success', async () => {
  let attempts = 0;
  const delays = [];
  const result = await request('https://example.com', 'ProgrammeResponse', {
    fetchImpl: async () => ++attempts < 3 ? new Response('busy', { status: 503 }) : new Response(programmeBytes),
    delay: async ms => delays.push(ms),
  });
  assert.equal(result.dataList.length, 39);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test('network and decode failures exhaust retries and propagate to the caller', async () => {
  for (const failure of [async () => { throw new Error('timeout'); }, async () => new Response('<html/>')]) {
    let attempts = 0;
    await assert.rejects(request('https://example.com', 'ProgrammeResponse', {
      fetchImpl: async () => { attempts++; return failure(); }, delay: async () => {},
    }));
    assert.equal(attempts, 3);
  }
});

test('fetch failures retain nested connection error codes after bounded retries', async () => {
  let attempts = 0;
  const cause = new AggregateError([
    Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('network unreachable'), { code: 'ENETUNREACH' }),
  ]);
  await assert.rejects(request('https://example.com', 'ProgrammeResponse', {
    fetchImpl: async () => { attempts++; throw new TypeError('fetch failed', { cause }); },
    delay: async () => {},
  }), error => /fetch failed/.test(error.message) && /ETIMEDOUT/.test(error.message) && /ENETUNREACH/.test(error.message));
  assert.equal(attempts, 3);
});

test('a transient connection failure can recover on the next request attempt', async () => {
  let attempts = 0;
  const delays = [];
  const result = await request('https://example.com', 'ProgrammeResponse', {
    fetchImpl: async () => {
      if (++attempts === 1) throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      });
      return new Response(programmeBytes);
    },
    delay: async ms => delays.push(ms),
  });
  assert.equal(result.dataList.length, 39);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1000]);
});
