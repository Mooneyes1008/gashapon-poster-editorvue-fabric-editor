/* Browser acceptance test. See docs/第一阶段验收.md for invocation. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(require.resolve('playwright-core', {
  paths: [process.env.PLAYWRIGHT_MODULE_PATH || process.cwd()],
}));
const base = process.env.POSTER_URL || 'http://127.0.0.1:3000/';
const artifacts = path.resolve(process.env.POSTER_ARTIFACTS || '/tmp/gashapon-acceptance');
async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1060 },
    acceptDownloads: true,
  });
  // All remote requests are forbidden: the local workflow must stand on its own.
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === new URL(base).origin ||
    /^(data:|blob:)/.test(route.request().url())
      ? route.continue()
      : route.abort()
  );
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (dialog) => dialog.accept());
  const checks = [];
  const check = async (name) => {
    checks.push(name);
    console.log(`PASS ${name}`);
  };
  const settled = async () => {
    await page.waitForFunction(() => !document.querySelector('.is-busy'));
    await page.getByRole('status').filter({ hasText: '已自动保存' }).waitFor();
  };
  const saved = () =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const r = indexedDB.open('gashapon-poster', 1);
          r.onsuccess = () => {
            const db = r.result;
            const q = db.transaction('projects').objectStore('projects').get('current');
            q.onsuccess = () => {
              db.close();
              resolve(q.result);
            };
            q.onerror = reject;
          };
          r.onerror = reject;
        })
    );
  const scene = (p) => p.pages.find((x) => x.id === p.activePageId).scene.objects;
  try {
    await page.goto(base);
    await page.getByRole('status').filter({ hasText: '已就绪' }).waitFor();
    assert.equal(await page.locator('canvas').count(), 2);
    await check('恢复后工具链启动的页面正常，无需在线 API');
    // Synthetic raster fixtures, never remote assets. PNG has genuine transparent pixels.
    const fixtures = await page.evaluate(() => {
      const out = [];
      for (const [i, mime] of ['image/png', 'image/jpeg', 'image/webp'].entries()) {
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = 320;
        const x = c.getContext('2d');
        if (mime === 'image/jpeg') {
          x.fillStyle = '#fff9ed';
          x.fillRect(0, 0, 320, 320);
        }
        x.fillStyle = ['#d99779', '#91ac92', '#b7adca'][i];
        x.beginPath();
        x.roundRect(65, 65, 190, 205, 65);
        x.fill();
        x.fillStyle = '#fff9ed';
        x.beginPath();
        x.ellipse(160, 160, 66, 60, 0, 0, Math.PI * 2);
        x.fill();
        x.fillStyle = '#375e4d';
        x.beginPath();
        x.arc(136, 156, 5, 0, 7);
        x.arc(184, 156, 5, 0, 7);
        x.fill();
        x.strokeStyle = '#375e4d';
        x.lineWidth = 4;
        x.beginPath();
        x.arc(160, 164, 15, 0, Math.PI);
        x.stroke();
        x.fillStyle = '#375e4d';
        x.font = 'bold 16px sans-serif';
        x.textAlign = 'center';
        x.fillText(['MOMO', 'MORI', 'SORA'][i], 160, 241);
        out.push(c.toDataURL(mime));
      }
      return out;
    });
    const names = ['桃桃.png', '森林.jpeg', '星空.webp'];
    await page.getByTestId('upload-assets').setInputFiles(
      fixtures.map((data, i) => ({
        name: names[i],
        mimeType: ['image/png', 'image/jpeg', 'image/webp'][i],
        buffer: Buffer.from(data.split(',')[1], 'base64'),
      }))
    );
    await settled();
    assert.equal((await saved()).assets.length, 3);
    await check('透明 PNG、JPEG、WebP 上传到共享资产库');
    await page.getByRole('button', { name: '添加图片 桃桃.png', exact: true }).click();
    await settled();
    // Native Fabric move/scale/clone operations, exercised through pointer controls.
    let picture = scene(await saved())[0];
    const firstBox = await page.locator('canvas.upper-canvas').boundingBox();
    const factor = firstBox.width / 900;
    const centerX = firstBox.x + (picture.left + (picture.width * picture.scaleX) / 2) * factor;
    const centerY = firstBox.y + (picture.top + (picture.height * picture.scaleY) / 2) * factor;
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX + 35, centerY + 25, { steps: 8 });
    await page.mouse.up();
    await settled();
    const moved = scene(await saved())[0];
    assert.ok(moved.left > picture.left + 20);
    assert.ok(moved.top > picture.top + 20);
    const cornerX = firstBox.x + (moved.left + moved.width * moved.scaleX) * factor;
    const cornerY = firstBox.y + (moved.top + moved.height * moved.scaleY) * factor;
    await page.mouse.move(cornerX, cornerY);
    await page.mouse.down();
    await page.mouse.move(cornerX + 26, cornerY + 26, { steps: 8 });
    await page.mouse.up();
    await settled();
    const scaled = scene(await saved())[0];
    assert.ok(scaled.scaleX > moved.scaleX);
    assert.ok(Math.abs(scaled.scaleX - scaled.scaleY) < 0.0001);
    await page.getByLabel('旋转角度', { exact: true }).fill('23');
    await page.getByLabel('旋转角度', { exact: true }).blur();
    await settled();
    await page.getByRole('button', { name: '复制', exact: true }).click();
    await settled();
    assert.equal(scene(await saved()).length, 2);
    await page
      .locator('.asset-card')
      .nth(1)
      .getByRole('button', { name: '替换选中', exact: true })
      .click();
    await settled();
    picture = scene(await saved())[1];
    assert.equal(picture.angle, 23);
    assert.equal(picture.assetId, (await saved()).assets[1].id);
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await settled();
    assert.equal(scene(await saved()).length, 1);
    await check('图片拖动、角点等比缩放、旋转、复制及保留角度替换');
    await page.getByRole('button', { name: '文字', exact: true }).click();
    await page.getByRole('button', { name: /文字工具/ }).click();
    const box = await page.locator('canvas.upper-canvas').boundingBox();
    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.1);
    await page.getByLabel('文字内容', { exact: true }).fill('春日扭蛋 · 全新登场');
    await page.getByLabel('文字内容', { exact: true }).blur();
    await settled();
    await page.getByLabel('字体', { exact: true }).selectOption('汉体');
    await settled();
    await page.getByLabel('字号', { exact: true }).fill('64');
    await page.getByLabel('字号', { exact: true }).blur();
    await page.getByLabel('描边宽度', { exact: true }).fill('2');
    await page.getByLabel('描边宽度', { exact: true }).blur();
    await page.getByLabel('阴影模糊', { exact: true }).fill('4');
    await page.getByLabel('阴影模糊', { exact: true }).blur();
    await page.getByLabel('字距', { exact: true }).fill('100');
    await page.getByLabel('字距', { exact: true }).blur();
    await settled();
    let p = await saved(),
      objects = scene(p),
      text = objects.find((o) => o.type === 'i-text');
    assert.equal(text.text, '春日扭蛋 · 全新登场');
    assert.equal(text.fontSize, 64);
    assert.equal(text.fontFamily, '汉体');
    assert.equal(text.strokeWidth, 2);
    assert.equal(text.charSpacing, 100);
    await check('点击画布添加文字，并修改字号、描边、阴影与字距');
    const row = page.locator(`[data-layer-id="${text.id}"]`);
    await row.getByLabel('图层名称', { exact: true }).fill('主标题');
    await row.getByLabel('图层名称', { exact: true }).blur();
    await settled();
    await row.getByRole('button', { name: '隐藏图层', exact: true }).click();
    await settled();
    assert.equal(scene(await saved()).find((o) => o.id === text.id).visible, false);
    await row.getByRole('button', { name: '显示图层', exact: true }).click();
    await row.getByRole('button', { name: '锁定图层', exact: true }).click();
    await settled();
    assert.equal(scene(await saved()).find((o) => o.id === text.id).locked, true);
    await row.getByRole('button', { name: '解锁图层', exact: true }).click();
    const image = objects.find((o) => o.type === 'image');
    await row
      .locator('.drag-handle')
      .dragTo(page.locator(`[data-layer-id="${image.id}"]`).locator('.drag-handle'));
    await settled();
    assert.equal(scene(await saved())[0].id, text.id);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await settled();
    assert.equal(scene(await saved())[1].id, text.id);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await settled();
    assert.equal(scene(await saved())[0].id, text.id);
    await check('图层重命名、隐藏、锁定、拖动排序、撤销和重做');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await settled();
    const before = JSON.stringify(await saved());
    await page.reload();
    await page.getByRole('status').filter({ hasText: '已就绪' }).waitFor();
    assert.equal(JSON.stringify(await saved()), before);
    assert.equal(
      await page.getByLabel('图层名称', { exact: true }).first().inputValue(),
      '桃桃.png'
    );
    await check('保存与刷新恢复，图层、文本属性、图片资产保持一致');
    // Double-click native Fabric IText, not an alternative text input implementation.
    p = await saved();
    text = scene(p).find((o) => o.type === 'i-text');
    const paper = await page.locator('canvas.upper-canvas').boundingBox();
    const zoom = paper.width / p.pages[0].width;
    await page.mouse.dblclick(paper.x + (text.left + 30) * zoom, paper.y + (text.top + 25) * zoom);
    await page.waitForFunction(
      () =>
        document.activeElement?.tagName === 'TEXTAREA' &&
        document.activeElement?.getAttribute('data-fabric-hiddentextarea') !== null
    );
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText('春日收藏 · 全三款');
    await page.mouse.click(paper.x + paper.width - 8, paper.y + paper.height - 8);
    await settled();
    assert.equal(scene(await saved()).find((o) => o.id === text.id).text, '春日收藏 · 全三款');
    await check('双击画布文字直接编辑');
    const pngDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 PNG ↗', exact: true }).click();
    const png = await pngDownload;
    const pngPath = path.join(artifacts, 'poster.png');
    await png.saveAs(pngPath);
    const bytes = await fs.readFile(pngPath);
    assert.equal(bytes.readUInt32BE(16), 1800);
    assert.equal(bytes.readUInt32BE(20), 2400);
    const selectedImage = scene(await saved()).find((o) => o.type === 'image');
    await page.locator(`[data-layer-id="${selectedImage.id}"]`).click();
    const selectedExport = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 PNG ↗', exact: true }).click();
    const selectedPngPath = path.join(artifacts, 'selected-poster.png');
    await (await selectedExport).saveAs(selectedPngPath);
    assert.deepEqual(await fs.readFile(selectedPngPath), bytes);
    await check('高清 PNG 导出 1800×2400，选中与未选中导出逐字节一致');
    const projectDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出项目', exact: true }).click();
    const projectFile = path.join(artifacts, 'roundtrip.gashapon.json');
    await (await projectDownload).saveAs(projectFile);
    const exported = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    assert.equal(exported.assets.length, 3);
    assert.match(exported.assets[0].data, /^data:image\/png/);
    assert.match(scene(exported).find((o) => o.type === 'image').src, /^asset:/);
    await page.getByRole('button', { name: '＋ 新页面', exact: true }).click();
    await settled();
    assert.equal(scene(await saved()).length, 0);
    await page.getByTestId('import-project').setInputFiles(projectFile);
    await settled();
    const imported = await saved();
    assert.deepEqual(imported, exported);
    await check('完整项目导出→新建页面→重新导入，所有资产与布局一致');
    await page.getByRole('button', { name: '模板', exact: true }).click();
    for (const title of ['春日收藏', '喫茶日和', '星屑放送', '小小百货']) {
      await page
        .getByRole('button')
        .filter({ has: page.locator('.template-caption strong', { hasText: title }) })
        .click();
      await settled();
    }
    p = await saved();
    assert.equal(p.pages.length, 5);
    for (const [index, count] of [3, 4, 5, 6].entries()) {
      const obj = p.pages[index + 1].scene.objects;
      assert.equal(obj.filter((o) => o.slot).length, count);
      assert.equal(obj.filter((o) => o.name?.startsWith('款式名称')).length, count);
    }
    await check('3/4/5/6 款模板均为独立可编辑对象，添加模板保留原页面');
    await page.getByRole('button', { name: '产品图', exact: true }).click();
    const slot = scene(p).find((o) => o.slot);
    await page.locator(`[data-layer-id="${slot.id}"]`).click();
    await page
      .locator('.asset-card')
      .first()
      .getByRole('button', { name: '替换选中', exact: true })
      .click();
    await settled();
    p = await saved();
    assert.equal(scene(p).find((o) => o.id === slot.id).type, 'image');
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await settled();
    assert.equal((await saved()).assets.length, 3);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await settled();
    await check('产品位替换、删除对象不删除共享素材、撤销恢复图片');
    await page.getByRole('button', { name: '4:3 横版', exact: true }).click();
    await settled();
    p = await saved();
    assert.equal(p.pages.find((x) => x.id === p.activePageId).width, 1200);
    assert.equal(p.pages[0].width, 900);
    await page.getByRole('button', { name: '3:4 竖版', exact: true }).click();
    await settled();
    await page.getByLabel('画布宽度', { exact: true }).fill('1000');
    await page.getByLabel('画布高度', { exact: true }).fill('1300');
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await settled();
    assert.equal((await saved()).pages.find((x) => x.id === p.activePageId).width, 1000);
    await page.getByRole('button', { name: '3:4 竖版', exact: true }).click();
    await settled();
    await check('画布预设及自定义尺寸，各页布局独立');
    // Invalid file must not replace the current project or fetch a remote image.
    const beforeInvalid = JSON.stringify(await saved());
    const bad = JSON.parse(beforeInvalid);
    bad.pages[0].scene.objects.find((o) => o.type === 'image').src =
      'https://example.com/unsafe.svg';
    await page.getByTestId('import-project').setInputFiles({
      name: 'bad.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(bad)),
    });
    await page.getByRole('alert').filter({ hasText: '项目格式无效' }).waitFor();
    assert.equal(JSON.stringify(await saved()), beforeInvalid);
    await check('拒绝含外部图片链接的无效项目，保持当前项目不变');
    // Attractive but truthful evidence: fill an actual editable template with uploaded raster fixtures.
    const threePage = (await saved()).pages[1];
    await page.locator('.pages-strip button').filter({ hasText: threePage.name }).click();
    await settled();
    for (const [index, slot] of threePage.scene.objects.filter((o) => o.slot).entries()) {
      await page.locator(`[data-layer-id="${slot.id}"]`).click();
      await page
        .locator('.asset-card')
        .nth(index % 3)
        .getByRole('button', { name: '替换选中', exact: true })
        .click();
      await settled();
    }
    await page.getByLabel('项目名称', { exact: true }).fill('春日小伙伴 · 扭蛋系列');
    await page.getByLabel('项目名称', { exact: true }).blur();
    await settled();
    await page.getByRole('button', { name: '模板', exact: true }).click();
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    await page.locator('canvas.upper-canvas').click({ position: { x: 8, y: 8 } });
    await page.locator('.inspector').evaluate((el) => (el.scrollTop = 0));
    await fs.writeFile(path.join(artifacts, 'demo.gashapon.json'), JSON.stringify(await saved()));
    await page.screenshot({ path: path.join(artifacts, 'editor.png'), fullPage: true });
    await page.getByRole('button', { name: '素材', exact: true }).click();
    await page.getByText('在线素材暂不可用', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'AI 找素材', exact: true }).click();
    await page.getByRole('button', { name: 'AI 找素材 · 尚未接入', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await check('在线服务不可用时提示清楚，AI 标明未接入；完整流程零页面异常');
    await fs.writeFile(
      path.join(artifacts, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          checks: checks.length,
          results: checks,
          pageErrors: errors,
          artifacts: ['editor.png', 'poster.png', 'roundtrip.gashapon.json'],
        },
        null,
        2
      )
    );
  } catch (e) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true });
    throw e;
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
