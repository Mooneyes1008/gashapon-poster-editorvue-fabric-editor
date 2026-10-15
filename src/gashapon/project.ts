/** Portable, local-first project format. Images live once in the shared asset library. */
export interface Asset {
  id: string;
  name: string;
  data: string;
  width: number;
  height: number;
  kind: 'product' | 'material';
}
export interface PosterPage {
  id: string;
  name: string;
  width: number;
  height: number;
  scene: { version: string; objects: any[]; background: string };
}
export interface PosterProject {
  format: 'gashapon-poster';
  version: 1;
  name: string;
  activePageId: string;
  assets: Asset[];
  pages: PosterPage[];
}
export const uid = () => crypto.randomUUID();
export const customKeys = ['id', 'name', 'assetId', 'slot', 'locked', 'selectable', 'evented'];
export function blankPage(name = '页面 1'): PosterPage {
  return {
    id: uid(),
    name,
    width: 900,
    height: 1200,
    scene: { version: '5.3.0', objects: [], background: '#fff9ed' },
  };
}
export function newProject(): PosterProject {
  const page = blankPage();
  return {
    format: 'gashapon-poster',
    version: 1,
    name: '我的扭蛋海报',
    activePageId: page.id,
    assets: [],
    pages: [page],
  };
}
export function dimensionsOK(width: number, height: number) {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 100 &&
    height >= 100 &&
    width <= 4096 &&
    height <= 4096 &&
    width * height <= 16000000
  );
}
const objectProperties = new Set(
  `type version originX originY left top width height fill stroke strokeWidth strokeDashArray strokeLineCap strokeDashOffset strokeLineJoin strokeUniform strokeMiterLimit scaleX scaleY angle flipX flipY opacity shadow visible backgroundColor fillRule paintFirst globalCompositeOperation skewX skewY id name assetId slot locked selectable evented rx ry radius startAngle endAngle text fontSize fontWeight fontFamily fontStyle lineHeight underline overline linethrough textAlign textBackgroundColor charSpacing styles direction path pathStartOffset pathSide pathAlign minWidth splitByGrapheme src crossOrigin filters cropX cropY`.split(
    ' '
  )
);
function noPrototypeKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.keys(value).every(
    (key) =>
      !['__proto__', 'prototype', 'constructor'].includes(key) &&
      noPrototypeKeys((value as any)[key])
  );
}
export const rasterData = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/;
/** Imports may not cause external network requests, execute SVG, or allocate arbitrary canvases. */
export function validateProject(input: unknown): PosterProject {
  const p = input as PosterProject;
  if (!noPrototypeKeys(input)) throw new Error('项目包含不安全的属性。');
  const fail = () => {
    throw new Error('项目格式无效、包含外部资源或超过限制。请选择本编辑器导出的完整项目。');
  };
  if (
    !p ||
    p.format !== 'gashapon-poster' ||
    p.version !== 1 ||
    typeof p.name !== 'string' ||
    !Array.isArray(p.pages) ||
    !p.pages.length ||
    p.pages.length > 30 ||
    !Array.isArray(p.assets) ||
    p.assets.length > 200
  )
    fail();
  const ids = new Set<string>();
  p.assets.forEach((a) => {
    if (
      !a ||
      typeof a.id !== 'string' ||
      ids.has(a.id) ||
      typeof a.name !== 'string' ||
      typeof a.data !== 'string' ||
      !rasterData.test(a.data) ||
      a.data.length > 28 * 1024 * 1024 ||
      !Number.isFinite(a.width) ||
      !Number.isFinite(a.height) ||
      a.width <= 0 ||
      a.height <= 0 ||
      a.width * a.height > 40000000 ||
      !['product', 'material'].includes(a.kind)
    )
      fail();
    ids.add(a.id);
  });
  if (p.assets.reduce((sum, asset) => sum + asset.data.length, 0) > 100 * 1024 * 1024) fail();
  const pageIds = new Set<string>();
  p.pages.forEach((page) => {
    if (
      !page ||
      typeof page.id !== 'string' ||
      pageIds.has(page.id) ||
      typeof page.name !== 'string' ||
      !dimensionsOK(page.width, page.height) ||
      !page.scene ||
      !Array.isArray(page.scene.objects) ||
      page.scene.objects.length > 500 ||
      typeof page.scene.background !== 'string' ||
      !/^#[\da-f]{6}$/i.test(page.scene.background)
    )
      fail();
    pageIds.add(page.id);
    const objectIds = new Set<string>();
    page.scene.objects.forEach((o) => {
      if (
        !o ||
        !['rect', 'circle', 'triangle', 'i-text', 'textbox', 'image'].includes(o.type) ||
        typeof o.id !== 'string' ||
        objectIds.has(o.id)
      )
        fail();
      objectIds.add(o.id);
      if (Object.keys(o).some((key) => !objectProperties.has(key))) fail();
      if (
        o.shadow &&
        (typeof o.shadow !== 'object' ||
          Object.keys(o.shadow).some(
            (key) =>
              !['color', 'blur', 'offsetX', 'offsetY', 'affectStroke', 'nonScaling'].includes(key)
          ))
      )
        fail();
      if (o.styles && Object.keys(o.styles).length) fail();
      if (
        o.strokeDashArray &&
        (!Array.isArray(o.strokeDashArray) ||
          o.strokeDashArray.length > 16 ||
          o.strokeDashArray.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v)))
      )
        fail();
      if (o.type === 'image' && (!ids.has(o.assetId) || o.src !== `asset:${o.assetId}`)) fail();
      for (const key of [
        'left',
        'top',
        'width',
        'height',
        'scaleX',
        'scaleY',
        'angle',
        'fontSize',
        'strokeWidth',
        'charSpacing',
        'lineHeight',
      ]) {
        if (
          o[key] !== undefined &&
          (typeof o[key] !== 'number' || !Number.isFinite(o[key]) || Math.abs(o[key]) > 100000)
        )
          fail();
      }
      if (o.text !== undefined && (typeof o.text !== 'string' || o.text.length > 10000)) fail();
      // Fabric supports nested clip paths, patterns and filters; this format deliberately does not.
      if (
        o.clipPath ||
        o.filters?.length ||
        o.resizeFilter ||
        o.objects ||
        o.path ||
        o.backgroundImage ||
        o.overlayImage ||
        (o.fill && typeof o.fill !== 'string') ||
        (o.stroke && typeof o.stroke !== 'string')
      )
        fail();
    });
    if (
      (page.scene as any).backgroundImage ||
      (page.scene as any).overlayImage ||
      (page.scene as any).clipPath
    )
      fail();
  });
  if (!pageIds.has(p.activePageId)) fail();
  return JSON.parse(JSON.stringify(p));
}
export function hydrateScene(page: PosterPage, assets: Asset[]) {
  const scene = JSON.parse(JSON.stringify(page.scene));
  scene.objects.forEach((o: any) => {
    if (o.type === 'image') {
      const asset = assets.find((a) => a.id === o.assetId);
      if (!asset) throw new Error('项目缺少图片资产');
      o.src = asset.data;
    }
  });
  return scene;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('gashapon-poster', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function readSavedProject(): Promise<PosterProject | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readonly');
    const req = tx.objectStore('projects').get('current');
    req.onsuccess = () => {
      try {
        resolve(req.result ? validateProject(req.result) : null);
      } catch (e) {
        reject(e);
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}
export async function writeSavedProject(project: PosterProject) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').put(project, 'current');
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}
