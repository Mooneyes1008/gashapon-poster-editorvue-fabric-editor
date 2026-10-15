import { describe, expect, test } from 'vitest';
import { base64ToBlob } from '../../utils/utils';
import {
  blankPage,
  dimensionsOK,
  hydrateScene,
  newProject,
  validateProject,
} from '../../../../src/gashapon/project';
import { templatePage } from '../../../../src/gashapon/templates';

function withImage() {
  const p = newProject();
  p.assets.push({
    id: 'asset-1',
    name: '透明产品.png',
    data: 'data:image/png;base64,aGVsbG8=',
    width: 10,
    height: 10,
    kind: 'product',
  });
  p.pages[0].scene.objects.push({
    id: 'object-1',
    type: 'image',
    assetId: 'asset-1',
    src: 'asset:asset-1',
    left: 100,
    top: 100,
  });
  return p;
}
describe('portable poster projects', () => {
  test('roundtrip retains images once in the library and resolves them for Fabric', () => {
    const p = withImage();
    const validated = validateProject(JSON.parse(JSON.stringify(p)));
    expect(validated).toEqual(p);
    expect(hydrateScene(validated.pages[0], validated.assets).objects[0].src).toBe(
      p.assets[0].data
    );
    expect(validated.pages[0].scene.objects[0].src).toBe('asset:asset-1');
  });
  test('page layouts are independent and removing an object retains its shared asset', () => {
    const p = withImage();
    p.pages.push(blankPage('第二页'));
    p.pages[0].scene.objects.pop();
    expect(validateProject(p).assets).toHaveLength(1);
    expect(p.pages[1].scene.objects).toHaveLength(0);
  });
  test.each([
    (p: any) => {
      p.pages[0].scene.objects[0].src = 'https://example.com/image.png';
    },
    (p: any) => {
      p.assets[0].data = 'data:image/svg+xml;base64,PHN2Zz4=';
    },
    (p: any) => {
      p.pages[0].scene.objects[0].assetId = 'missing';
    },
    (p: any) => {
      p.pages[0].scene.objects[0].clipPath = { type: 'image', src: 'https://example.com/a' };
    },
    (p: any) => {
      p.pages[0].scene.objects[0].fill = { type: 'pattern', source: 'https://example.com/a' };
    },
    (p: any) => {
      p.pages[0].scene.objects[0].type = 'svg';
    },
    (p: any) => {
      p.pages[0].width = 100000;
    },
    (p: any) => {
      p.pages[0].scene.objects[0].scaleX = Infinity;
    },
    (p: any) => {
      p.pages.push(p.pages[0]);
    },
    (p: any) => {
      p.activePageId = 'missing';
    },
  ])('rejects unsafe or corrupt imports (%#)', (mutate) => {
    const p = withImage();
    mutate(p);
    expect(() => validateProject(p)).toThrow();
  });
  test('all templates have separate product slots, style names and decorations', () => {
    for (let index = 0; index < 4; index++) {
      const page = templatePage(index),
        p = newProject();
      p.pages = [page];
      p.activePageId = page.id;
      expect(validateProject(p).pages[0].scene.objects.filter((o) => o.slot)).toHaveLength(
        index + 3
      );
      expect(page.scene.objects.filter((o) => o.name.startsWith('款式名称'))).toHaveLength(
        index + 3
      );
      expect(page.scene.objects.some((o) => o.name === '海报标题' && o.type === 'i-text')).toBe(
        true
      );
      expect(page.scene.objects.every((o) => o.type !== 'group')).toBe(true);
    }
  });
  test('rejects prototype keys and method overrides before Fabric sees them', () => {
    const p = withImage();
    p.pages[0].scene.objects[0].set = 'not-a-function';
    expect(() => validateProject(p)).toThrow();
    delete p.pages[0].scene.objects[0].set;
    Object.assign(
      p.pages[0].scene.objects[0],
      JSON.parse('{"shadow":{"__proto__":{"polluted":true}}}')
    );
    expect(() => validateProject(p)).toThrow();
    expect(({} as any).polluted).toBeUndefined();
  });
  test('limits canvas allocation', () => {
    expect(dimensionsOK(900, 1200)).toBe(true);
    expect(dimensionsOK(1200, 900)).toBe(true);
    expect(dimensionsOK(99, 100)).toBe(false);
    expect(dimensionsOK(4096, 4096)).toBe(false);
    expect(dimensionsOK(100.5, 200)).toBe(false);
  });
});

test('shared image helper rejects malformed headers without crashing', () => {
  expect(base64ToBlob('not-an-image')).toBeNull();
  expect(base64ToBlob('data:image/png;base64,aGVsbG8=')?.[1]).toBe('png');
});

test('imported material provenance survives project roundtrip and cannot contain script URLs', () => {
  const p = withImage();
  p.assets[0].provenance = {
    provider: 'wikimedia',
    title: 'flower',
    creator: 'An artist',
    license: 'BY-SA',
    licenseVersion: '4.0',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Flower.png',
    originalUrl: 'https://upload.wikimedia.org/flower.png',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    attribution: 'An artist / BY-SA 4.0',
    importedAt: '2026-10-15T00:00:00.000Z',
    reason: '真实关键词检索',
  };
  expect(validateProject(JSON.parse(JSON.stringify(p))).assets[0].provenance).toEqual(
    p.assets[0].provenance
  );
  p.assets[0].provenance.sourceUrl = 'javascript:alert(1)';
  expect(() => validateProject(p)).toThrow();
});
