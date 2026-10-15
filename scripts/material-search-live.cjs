/* Live network acceptance: never mocks source, image, or AI responses. */
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(require.resolve('playwright-core', {
  paths: [process.env.PLAYWRIGHT_MODULE_PATH || process.cwd()],
}));
async function main() {
  const out = path.resolve(process.env.MATERIAL_ARTIFACTS || '/tmp/gashapon-materials-live');
  await fs.mkdir(out, { recursive: true });
  for (const name of ['result.json', 'failure.json', 'failure.png'])
    await fs.rm(path.join(out, name), { force: true });
  const startedAt = new Date().toISOString();
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({
    baseURL: process.env.POSTER_URL || 'http://127.0.0.1:3000/',
    viewport: { width: 1600, height: 1060 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(process.env.POSTER_URL || 'http://127.0.0.1:3000/');
    await page.getByRole('status').filter({ hasText: '已就绪' }).waitFor();
    await page.getByRole('button', { name: 'AI 找素材', exact: true }).click();
    await page.getByText('安全配置与费用', { exact: true }).click();
    await page.screenshot({ path: path.join(out, 'configuration.png'), fullPage: true });
    const status = await (await page.request.get('/api/material-search/status')).json();
    if (!status.aiConfigured) {
      await page.getByRole('button', { name: '自然语言 + AI', exact: true }).click();
      assert.equal(
        await page.getByRole('button', { name: '分析并检索（调用 AI）', exact: true }).isDisabled(),
        true
      );
    }
    await page.getByRole('button', { name: '关键词直接搜索', exact: true }).click();
    await page.getByLabel('真实素材入口', { exact: true }).selectOption('commons');
    await page.getByLabel('素材检索关键词', { exact: true }).fill('flower');
    const responsePromise = page.waitForResponse(
      (r) => r.url().endsWith('/api/material-search/search') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: '搜索真实素材（不调用 AI）', exact: true }).click();
    const response = await responsePromise;
    const data = await response.json();
    if (!response.ok()) throw new Error(`真实素材请求失败：${data.code} ${data.message}`);
    assert.equal(data.provider, 'Wikimedia Commons');
    assert.ok(data.candidates.length > 0, '真实 API 没有返回可导入素材');
    assert.equal(data.mode, 'keywords');
    const candidate = data.candidates[0];
    assert.match(candidate.sourceUrl, /commons.wikimedia.org/);
    assert.match(candidate.license, /BY|CC0|PDM/);
    const preview = await page.request.get(candidate.previewUrl);
    assert.equal(preview.status(), 200);
    assert.match(preview.headers()['content-type'], /^image\/(png|jpeg|webp)$/);
    await fs.writeFile(path.join(out, 'search-metadata.json'), JSON.stringify(data, null, 2));
    await page.getByLabel('确认素材授权', { exact: true }).check();
    const first = page.locator(`[data-result-id="${candidate.id}"]`);
    await first.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'real-results.png'), fullPage: true });
    await first.getByRole('button', { name: '加入共享素材库', exact: true }).click();
    const card = page.locator('.asset-card').first();
    await card.waitFor();
    await page.getByRole('status').filter({ hasText: '已自动保存' }).waitFor();
    await card.locator('.asset-image').click();
    await page.getByRole('status').filter({ hasText: '已自动保存' }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.is-busy'));
    await page.locator('.layer-row').first().waitFor();
    assert.equal(await page.locator('.layer-row').count(), 1);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出项目', exact: true }).click();
    const projectFile = path.join(out, 'real-material.gashapon.json');
    await (await download).saveAs(projectFile);
    const project = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    assert.equal(project.assets.length, 1);
    assert.equal(project.assets[0].provenance.sourceUrl, candidate.sourceUrl);
    assert.equal(project.assets[0].provenance.attribution, candidate.attribution);
    assert.match(project.assets[0].data, /^data:image\//);
    await page.reload();
    await page.getByRole('status').filter({ hasText: '已就绪' }).waitFor();
    await page.getByRole('button', { name: '素材', exact: true }).click();
    await page.locator('.asset-card').first().waitFor();
    await page.waitForFunction(() => !document.querySelector('.is-busy'));
    await page.locator('.layer-row').first().waitFor();
    assert.equal(await page.locator('.layer-row').count(), 1);
    assert.equal(
      await page.locator('.asset-card a').first().getAttribute('href'),
      candidate.sourceUrl
    );
    await page.screenshot({ path: path.join(out, 'imported-material.png'), fullPage: true });
    assert.deepEqual(errors, []);
    const result = {
      passed: true,
      startedAt,
      completedAt: new Date().toISOString(),
      provider: data.provider,
      mode: data.mode,
      sourceUrl: candidate.sourceUrl,
      license: candidate.license,
      attribution: candidate.attribution,
      query: data.query,
      candidates: data.candidates.length,
      aiConfigured: status.aiConfigured,
      aiPaidFlowVerified: false,
      checks: [
        'real search',
        'real image preview',
        'license metadata',
        'asset import',
        'canvas insertion',
        'embedded-image project export',
        'refresh recovery with provenance',
      ],
      pageErrors: errors,
    };
    await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true });
    await fs.writeFile(
      path.join(out, 'failure.json'),
      JSON.stringify({ passed: false, message: error.message }, null, 2)
    );
    throw error;
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
