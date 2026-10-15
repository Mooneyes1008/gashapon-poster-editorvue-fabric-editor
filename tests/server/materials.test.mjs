import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { publicMediaUrl, downloadMedia, imageMime } from '../../server/network.mjs';
import { searchOpenverse, normalizeResult, hasTransparentPixels } from '../../server/openverse.mjs';
import { searchCommons, normalizeCommons } from '../../server/commons.mjs';
import { analyzeRequirements, analyzeImages, validatePlan } from '../../server/ai.mjs';
import { MaterialService } from '../../server/service.mjs';
import { createMaterialServer, localRequest } from '../../server/index.mjs';
const config = { aiKey: 'test-key-not-real', model: 'gpt-4.1-mini', visual: true, proxy: '' };
const plan = {
  styles: ['复古'],
  colors: ['粉色'],
  types: ['花朵'],
  exclude: ['人物'],
  transparent: false,
  keywords: {
    zh: ['樱花', '复古花卉'],
    en: ['cherry blossom', 'vintage flower'],
    ja: ['桜', 'レトロ花'],
  },
};
function png(alpha = 255) {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(255);
  image.data[3] = alpha;
  return PNG.sync.write(image);
}
function record() {
  return {
    id: '12345678-1234-1234-1234-123456789abc',
    title: 'Flower',
    creator: 'Author',
    source: 'wikimedia',
    foreign_landing_url: 'https://commons.wikimedia.org/wiki/File:Flower.png',
    license: 'by',
    license_version: '4.0',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    url: 'https://upload.wikimedia.org/example.png',
    thumbnail: 'https://upload.wikimedia.org/thumb.png',
    width: 200,
    height: 200,
  };
}
const candidate = () => normalizeResult(record());
test('Openverse makes an actual API-shaped request with editable commercial licenses and no mature content', async () => {
  let called;
  const response = await searchOpenverse('flower', config, { transparent: true }, async (url) => {
    called = new URL(url);
    return { results: [record()], next: null, result_count: 1 };
  });
  assert.equal(called.hostname, 'api.openverse.org');
  assert.equal(called.searchParams.get('extension'), 'png');
  assert.equal(called.searchParams.get('license'), 'cc0,pdm,by,by-sa');
  assert.equal(response.candidates.length, 1);
  assert.match(response.candidates[0].attribution, /Author/);
});
test('no invented candidates for empty/error results and unsuitable licenses are removed', async () => {
  assert.equal(
    (await searchOpenverse('none', config, {}, async () => ({ results: [] }))).candidates.length,
    0
  );
  assert.equal(normalizeResult({ ...record(), license: 'by-nc' }), null);
  assert.equal(normalizeResult({ ...record(), mature: true }), null);
  assert.equal(normalizeResult({ ...record(), width: 100000, height: 100000 }), null);
  await assert.rejects(
    searchOpenverse('flower', config, {}, async () => ({ html: 'challenge' })),
    /格式异常/
  );
});
test('only fixed public image hosts are eligible; redirects are revalidated', async () => {
  for (const url of [
    'http://upload.wikimedia.org/a',
    'https://localhost/a',
    'https://127.0.0.1/a',
    'https://upload.wikimedia.org.evil.test/a',
    'https://user:secret@upload.wikimedia.org/a',
    'https://upload.wikimedia.org:3001/a',
    'https://169.254.169.254/latest/meta-data',
  ])
    assert.throws(() => publicMediaUrl(url));
  assert.equal(
    publicMediaUrl('https://upload.wikimedia.org/a.png').hostname,
    'upload.wikimedia.org'
  );
  await assert.rejects(
    downloadMedia('https://upload.wikimedia.org/a', config, async () => ({
      status: 302,
      headers: { location: 'https://127.0.0.1/private' },
    })),
    /不支持安全导入/
  );
});
test('only real transparent PNG pixels qualify, not extension or white backgrounds', () => {
  assert.equal(hasTransparentPixels(png(0), 'image/png'), true);
  assert.equal(hasTransparentPixels(png(255), 'image/png'), false);
  assert.equal(hasTransparentPixels(png(0), 'image/jpeg'), false);
  assert.throws(() => imageMime(Buffer.from('<svg/>')), /不是有效/);
  const enormous = png();
  enormous.writeUInt32BE(100000, 16);
  enormous.writeUInt32BE(100000, 20);
  assert.throws(() => hasTransparentPixels(enormous, 'image/png'), /像素限制/);
});
test('Commons license and HTML metadata normalization is conservative', () => {
  const entry = {
    pageid: 123,
    title: 'File:Flower.png',
    imageinfo: [
      {
        mime: 'image/png',
        url: record().url,
        thumburl: record().thumbnail,
        descriptionurl: record().foreign_landing_url,
        width: 200,
        height: 200,
        extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          LicenseUrl: { value: record().license_url },
          Artist: { value: '<a href="https://example.com">An artist</a>' },
        },
      },
    ],
  };
  const result = normalizeCommons(entry);
  assert.equal(result.license, 'BY-SA');
  assert.equal(result.creator, 'An artist');
  assert.match(result.id, /commons-/);
  entry.imageinfo[0].extmetadata.LicenseShortName.value = 'All rights reserved';
  assert.equal(normalizeCommons(entry), null);
});
test('Commons direct request is explicit, not mislabeled as an Openverse result', async () => {
  let host;
  const result = await searchCommons('flower', config, {}, async (url) => {
    host = new URL(url).hostname;
    return { batchcomplete: '', query: { pages: {} } };
  });
  assert.equal(host, 'commons.wikimedia.org');
  assert.deepEqual(result.candidates, []);
});
test('text analysis is server-side, preserves refinement history, and validates model output', async () => {
  const output = await analyzeRequirements(
    '复古花卉',
    ['更复古', '不要人物', '只要透明素材'],
    config,
    async (url, options) => {
      assert.equal(new URL(url).hostname, 'api.openai.com');
      assert.equal(options.headers.Authorization, `Bearer ${config.aiKey}`);
      const body = JSON.parse(options.body);
      assert.match(body.messages[1].content, /只要透明素材/);
      assert.equal(body.response_format.type, 'json_schema');
      return {
        choices: [{ message: { content: JSON.stringify({ ...plan, transparent: true }) } }],
      };
    }
  );
  assert.equal(output.transparent, true);
  assert.deepEqual(output.exclude, ['人物']);
  assert.throws(() => validatePlan({ ...plan, keywords: { en: [], zh: [], ja: [] } }), /关键词/);
});
test('missing key never yields fake AI output; visual requests actually contain images', async () => {
  await assert.rejects(analyzeRequirements('flower', [], { ...config, aiKey: '' }), /尚未配置 AI/);
  let requested = false;
  const items = [
    { ...candidate(), imageData: `data:image/png;base64,${png().toString('base64')}` },
  ];
  const result = await analyzeImages(plan, items, config, async (url, options) => {
    requested = true;
    const body = JSON.parse(options.body);
    assert.equal(body.messages[0].content[2].type, 'image_url');
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              results: [
                { token: items[0].token, match: true, score: 85, reason: '花朵配色符合要求' },
              ],
            }),
          },
        },
      ],
    };
  });
  assert.equal(requested, true);
  assert.equal(result[0].score, 85);
});
test('service imports only issued tokens and retains provenance, no key leaks in status', async () => {
  const service = new MaterialService(config, {
    searchProvider: async () => ({ candidates: [candidate()], hasMore: false }),
    loadImage: async () => ({ bytes: png(), mime: 'image/png' }),
  });
  assert.ok(!JSON.stringify(service.status()).includes(config.aiKey));
  const result = await service.search({ mode: 'keywords', source: 'openverse', query: 'flower' });
  assert.equal(result.candidates[0].visual, 'not-analyzed');
  assert.equal(result.provider, 'Openverse');
  assert.equal(result.candidates[0].originalUrl, undefined);
  await assert.rejects(service.import('arbitrary-url', true), /已过期/);
  await assert.rejects(service.import(result.candidates[0].token, false), /授权/);
  const imported = await service.import(result.candidates[0].token, true);
  assert.match(imported.data, /^data:image\/png;base64,/);
  assert.equal(imported.provenance.sourceUrl, record().foreign_landing_url);
  assert.match(imported.provenance.attribution, /Author/);
});
test('AI filtering excludes rejected or unanalysed images rather than pretending they match', async () => {
  const first = candidate(),
    second = { ...candidate(), id: 'second' };
  const service = new MaterialService(config, {
    searchProvider: async () => ({ candidates: [first, second] }),
    loadImage: async () => ({ bytes: png(), mime: 'image/png' }),
    analyzeVisual: async () => [
      { token: first.token, match: false, score: 0, reason: '包含人物' },
      { token: second.token, match: true, score: 80, reason: '复古花朵，不含人物' },
    ],
  });
  const result = await service.search({ mode: 'ai', source: 'openverse', plan });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, 'second');
  assert.equal(result.candidates[0].visual, 'analyzed');
});
test('transparent requirement is rechecked on import', async () => {
  const first = candidate();
  const service = new MaterialService(config, {
    searchProvider: async () => ({ candidates: [first] }),
    loadImage: async () => ({ bytes: png(0), mime: 'image/png' }),
  });
  const result = await service.search({ mode: 'keywords', query: 'flower', transparent: true });
  assert.equal(result.candidates[0].transparency, 'verified');
  service.images.clear();
  service.imageBytes = 0;
  service.loadImage = async () => ({ bytes: png(255), mime: 'image/png' });
  await assert.rejects(service.import(result.candidates[0].token, true), /不再满足/);
});
test('local HTTP boundary blocks cross-origin and does not accept arbitrary download URLs', async (t) => {
  assert.equal(
    localRequest({ headers: { host: '127.0.0.1:3001', origin: 'https://evil.example' } }),
    false
  );
  const service = new MaterialService({ ...config, aiKey: '' });
  const server = createMaterialServer(service);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  assert.equal(
    (
      await fetch(`${root}/api/material-search/status`, {
        headers: { Origin: 'https://evil.example' },
      })
    ).status,
    403
  );
  const status = await (await fetch(`${root}/api/material-search/status`)).json();
  assert.equal(status.aiConfigured, false);
  assert.equal(status.aiKey, undefined);
  const response = await fetch(`${root}/api/material-search/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'https://localhost/private', acceptLicense: true }),
  });
  assert.equal(response.status, 410);
});

test('service errors are explicit for disabled AI, expired results and invalid input', async () => {
  const service = new MaterialService({ ...config, aiKey: '' });
  await assert.rejects(service.search({ mode: 'ai', plan }), /尚未配置/);
  await assert.rejects(searchCommons('', config), /请输入/);
  const item = candidate();
  service.remember(item);
  service.cache.get(item.token).created = 0;
  await assert.rejects(service.import(item.token, true), /已过期/);
  await assert.rejects(
    analyzeImages(
      plan,
      [{ ...candidate(), imageData: 'data:image/png;base64,x' }],
      config,
      async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                results: [{ token: 'forged', match: true, score: 100, reason: 'invented' }],
              }),
            },
          },
        ],
      })
    ),
    /格式异常/
  );
});
