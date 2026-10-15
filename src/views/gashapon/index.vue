<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { fabric } from 'fabric';
import { getImgStr, downFile } from '../../../packages/core/utils/utils';
import {
  blankPage,
  customKeys,
  dimensionsOK,
  hydrateScene,
  newProject,
  readSavedProject,
  uid,
  validateProject,
  writeSavedProject,
  type Asset,
  type PosterPage,
  type PosterProject,
} from '../../gashapon/project';
import { templatePage, templates } from '../../gashapon/templates';
import { materialSearchProvider } from '../../gashapon/ai';

const project = ref<PosterProject>(newProject());
const current = computed(
  () => project.value.pages.find((p) => p.id === project.value.activePageId)!
);
const tab = ref('product');
const tabs = [
  { id: 'product', icon: '◈', name: '产品图' },
  { id: 'material', icon: '✿', name: '素材' },
  { id: 'template', icon: '▦', name: '模板' },
  { id: 'text', icon: 'T', name: '文字' },
  { id: 'ai', icon: '✧', name: 'AI 找素材' },
];
const assets = computed(() =>
  project.value.assets.filter((a) => a.kind === (tab.value === 'material' ? 'material' : 'product'))
);
const canvasEl = ref<HTMLCanvasElement>();
const stage = ref<HTMLDivElement>();
const fileInput = ref<HTMLInputElement>();
const importInput = ref<HTMLInputElement>();
const replaceInput = ref<HTMLInputElement>();
const ready = ref(false);
const busy = ref(false);
const status = ref('正在恢复项目…');
const message = ref('');
const error = ref(false);
const tool = ref('select');
const scale = ref(1);
const layers = ref<{ id: string; name: string; type: string; visible: boolean; locked: boolean }[]>(
  []
);
const selectedId = ref('');
const selectedType = ref('');
const selectedLocked = ref(false);
const selectedSlot = ref(false);
const size = reactive({ width: 900, height: 1200 });
const props = reactive({
  name: '',
  text: '',
  fontFamily: 'sans-serif',
  fontSize: 48,
  fill: '#375e4d',
  stroke: '#ffffff',
  strokeWidth: 0,
  shadowColor: '#000000',
  shadowBlur: 0,
  shadowOffset: 0,
  lineHeight: 1.2,
  charSpacing: 0,
  angle: 0,
});
const exportScale = ref(2);
const canUndo = ref(false);
const canRedo = ref(false);
let canvas: fabric.Canvas;
let observer: ResizeObserver;
let restoring = false;
let disposed = false;
let saveQueue: Promise<unknown> = Promise.resolve();
let saveRevision = 0;
let draggedId = '';
const histories = new Map<string, { items: string[]; index: number }>();
const fonts = [
  { value: 'sans-serif', label: '系统黑体' },
  { value: 'serif', label: '系统宋体' },
  { value: 'monospace', label: '等宽字体' },
  { value: '汉体', label: '汉体（内置）' },
  { value: '华康金刚黑', label: '华康金刚黑（内置）' },
];
function notify(text: string, failed = false) {
  message.value = text;
  error.value = failed;
}
function editingText() {
  return !!(canvas?.getActiveObject() as fabric.IText)?.isEditing;
}
function snapshot() {
  // Discard multi-selection so objects are serialized in absolute page coordinates.
  const selection = canvas.getActiveObject();
  if (selection?.type === 'activeSelection') canvas.discardActiveObject();
  const json = canvas.toJSON(customKeys);
  json.objects.forEach((o: any) => {
    if (o.type === 'image') o.src = `asset:${o.assetId}`;
  });
  current.value.scene = {
    version: fabric.version,
    objects: json.objects,
    background: String(canvas.backgroundColor || '#ffffff'),
  };
}
function persist() {
  if (!ready.value || disposed) return;
  const revision = ++saveRevision;
  status.value = '正在保存…';
  const copy = JSON.parse(JSON.stringify(project.value));
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(() => writeSavedProject(copy))
    .then(() => {
      if (revision === saveRevision) status.value = '已自动保存到本机';
    })
    .catch(() => {
      status.value = '自动保存失败';
      notify('浏览器存储不可用或空间不足，请立即导出完整项目备份。', true);
    });
}
function historyButtons() {
  const h = histories.get(current.value.id);
  canUndo.value = !!h && h.index > 0;
  canRedo.value = !!h && h.index < h.items.length - 1;
}
function remember() {
  const state = JSON.stringify(current.value);
  let h = histories.get(current.value.id);
  if (!h) {
    h = { items: [], index: -1 };
    histories.set(current.value.id, h);
  }
  if (h.items[h.index] !== state) {
    h.items.splice(h.index + 1);
    h.items.push(state);
    if (h.items.length > 60) h.items.shift();
    h.index = h.items.length - 1;
  }
  historyButtons();
}
function refreshLayers() {
  layers.value = canvas
    .getObjects()
    .slice()
    .reverse()
    .map((o: any) => ({
      id: o.id,
      name: o.name || o.text || '对象',
      type: o.type,
      visible: o.visible !== false,
      locked: !!o.locked,
    }));
}
function updateSelection() {
  const o = canvas.getActiveObject() as any;
  selectedId.value = o?.id || '';
  selectedType.value = o?.type || '';
  selectedLocked.value = !!o?.locked;
  selectedSlot.value = !!o?.slot;
  if (!o) return;
  Object.assign(props, {
    name: o.name || '',
    text: o.text || '',
    fontFamily: o.fontFamily || 'sans-serif',
    fontSize: o.fontSize || 48,
    fill: typeof o.fill === 'string' && /^#/.test(o.fill) ? o.fill : '#375e4d',
    stroke: o.stroke || '#ffffff',
    strokeWidth: o.strokeWidth || 0,
    lineHeight: o.lineHeight || 1.2,
    charSpacing: o.charSpacing || 0,
    angle: o.angle || 0,
    shadowColor: o.shadow?.color || '#000000',
    shadowBlur: o.shadow?.blur || 0,
    shadowOffset: o.shadow?.offsetX || 0,
  });
}
function changed() {
  if (restoring || !ready.value || busy.value) return;
  snapshot();
  refreshLayers();
  updateSelection();
  remember();
  persist();
}
function fit() {
  if (!canvas || !stage.value) return;
  const rect = stage.value.getBoundingClientRect();
  scale.value = Math.min(
    (rect.width - 80) / current.value.width,
    (rect.height - 64) / current.value.height,
    1
  );
  scale.value = Math.max(0.06, scale.value);
  canvas.setDimensions({
    width: current.value.width * scale.value,
    height: current.value.height * scale.value,
  });
  canvas.setZoom(scale.value);
  canvas.requestRenderAll();
}
function loadScene(page: PosterPage) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('图片载入超时，请保留项目备份后重试。')),
      20000
    );
    canvas.discardActiveObject();
    canvas.loadFromJSON(hydrateScene(page, project.value.assets), () => {
      window.clearTimeout(timer);
      canvas.getObjects().forEach((o: any) => {
        o.set({
          selectable: !o.locked,
          evented: !o.locked,
          lockMovementX: !!o.locked,
          lockMovementY: !!o.locked,
          lockScalingX: !!o.locked,
          lockScalingY: !!o.locked,
          lockRotation: !!o.locked,
          hasControls: !o.locked,
          lockScalingFlip: true,
          cornerColor: '#375e4d',
          transparentCorners: false,
          borderColor: '#375e4d',
        });
      });
      size.width = page.width;
      size.height = page.height;
      fit();
      refreshLayers();
      updateSelection();
      resolve();
    });
  });
}
async function run(action: () => Promise<void>) {
  if (busy.value || !ready.value) return;
  if (editingText()) (canvas.getActiveObject() as fabric.IText).exitEditing();
  busy.value = true;
  try {
    await action();
  } catch (e) {
    notify(e instanceof Error ? e.message : '操作失败，请重试', true);
  } finally {
    busy.value = false;
  }
}
async function historyMove(offset: number) {
  await run(async () => {
    const h = histories.get(current.value.id);
    if (!h || h.index + offset < 0 || h.index + offset >= h.items.length) return;
    h.index += offset;
    const page = JSON.parse(h.items[h.index]);
    project.value.pages.splice(
      project.value.pages.findIndex((p) => p.id === page.id),
      1,
      page
    );
    await loadScene(page);
    historyButtons();
    persist();
  });
}
async function switchPage(id: string) {
  if (id === current.value.id) return;
  await run(async () => {
    snapshot();
    project.value.activePageId = id;
    await loadScene(current.value);
    remember();
    persist();
  });
}
async function addPage(copy = false) {
  await run(async () => {
    if (project.value.pages.length >= 30) throw new Error('每个项目最多 30 页。');
    snapshot();
    const page = copy
      ? {
          ...JSON.parse(JSON.stringify(current.value)),
          id: uid(),
          name: `${current.value.name} 副本`,
        }
      : blankPage(`页面 ${project.value.pages.length + 1}`);
    project.value.pages.push(page);
    project.value.activePageId = page.id;
    await loadScene(page);
    remember();
    persist();
  });
}
async function deletePage() {
  if (project.value.pages.length === 1) return notify('至少保留一个页面。');
  if (!window.confirm(`删除「${current.value.name}」？共享资产会保留。`)) return;
  await run(async () => {
    const id = current.value.id;
    project.value.pages = project.value.pages.filter((p) => p.id !== id);
    histories.delete(id);
    project.value.activePageId = project.value.pages[0].id;
    await loadScene(current.value);
    remember();
    persist();
  });
}
function selectLayer(id: string) {
  if (busy.value) return;
  const o = canvas.getObjects().find((o: any) => o.id === id);
  if (o) {
    canvas.discardActiveObject();
    canvas.setActiveObject(o);
    updateSelection();
    canvas.requestRenderAll();
  }
}
function mutate(action: () => void) {
  if (busy.value || !ready.value) return;
  action();
  canvas.requestRenderAll();
  changed();
}
function layerAction(id: string, action: string) {
  const o = canvas.getObjects().find((o: any) => o.id === id) as any;
  if (!o) return;
  mutate(() => {
    if (action === 'hide') o.set('visible', !o.visible);
    if (action === 'lock') {
      o.set({
        locked: !o.locked,
        selectable: !!o.locked,
        evented: !!o.locked,
        lockMovementX: !o.locked,
        lockMovementY: !o.locked,
        lockScalingX: !o.locked,
        lockScalingY: !o.locked,
        lockRotation: !o.locked,
        hasControls: !!o.locked,
      });
      canvas.discardActiveObject();
    }
    if (action === 'delete') canvas.remove(o);
  });
}
function startDrag(id: string, event: DragEvent) {
  draggedId = id;
  event.dataTransfer?.setData('text/plain', id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}
function reorder(target: string, event: DragEvent) {
  draggedId = event.dataTransfer?.getData('text/plain') || draggedId;
  if (!draggedId || draggedId === target) return;
  mutate(() => {
    const objects = canvas.getObjects();
    const source = objects.find((o: any) => o.id === draggedId);
    const index = objects.findIndex((o: any) => o.id === target);
    if (source && index >= 0) canvas.moveTo(source, index);
  });
  draggedId = '';
}
function moveLayer(offset: number) {
  mutate(() => {
    const o = canvas.getActiveObject();
    if (o)
      canvas.moveTo(
        o,
        Math.max(
          0,
          Math.min(canvas.getObjects().length - 1, canvas.getObjects().indexOf(o) + offset)
        )
      );
  });
}
function renameLayer(id: string, event: Event) {
  const o = canvas.getObjects().find((o: any) => o.id === id);
  if (o)
    mutate(() =>
      o.set(
        'name' as any,
        (event.target as HTMLInputElement).value.trim().slice(0, 100) || '未命名对象'
      )
    );
}
function removeSelected() {
  if (selectedLocked.value) return;
  mutate(() => {
    const objects = canvas.getActiveObjects();
    canvas.discardActiveObject();
    objects.forEach((o) => canvas.remove(o));
  });
}
async function cloneSelected() {
  const o = canvas.getActiveObject();
  if (!o || selectedLocked.value || o.type === 'activeSelection') return;
  await run(async () => {
    const copy = await new Promise<fabric.Object>((resolve) => o.clone(resolve, customKeys));
    copy.set({
      id: uid(),
      name: `${(o as any).name || '对象'} 副本`,
      left: (o.left || 0) + 24,
      top: (o.top || 0) + 24,
    } as any);
    canvas.add(copy);
    canvas.setActiveObject(copy);
    canvas.requestRenderAll();
    snapshot();
    refreshLayers();
    updateSelection();
    remember();
    persist();
  });
}
async function applyProps() {
  const o = canvas.getActiveObject() as any;
  if (!o || o.locked) return;
  if (o.type.includes('text') && o.fontFamily !== props.fontFamily) {
    busy.value = true;
    try {
      await document.fonts.load(
        `${Math.max(8, Number(props.fontSize) || 48)}px "${props.fontFamily}"`
      );
      fabric.util.clearFabricFontCache(props.fontFamily);
    } catch {
      return notify('字体无法载入，请选择系统字体。', true);
    } finally {
      busy.value = false;
    }
    if (canvas.getActiveObject() !== o) return;
  }
  mutate(() => {
    o.set({ name: props.name, angle: Number(props.angle) || 0 });
    if (o.type.includes('text')) {
      o.set({
        text: props.text.slice(0, 10000),
        fontFamily: props.fontFamily,
        fontSize: Math.max(8, Math.min(500, Number(props.fontSize) || 48)),
        fill: props.fill,
        stroke: props.stroke,
        strokeWidth: Math.max(0, Math.min(30, Number(props.strokeWidth) || 0)),
        paintFirst: 'stroke',
        lineHeight: Math.max(0.5, Math.min(4, Number(props.lineHeight) || 1.2)),
        charSpacing: Math.max(-200, Math.min(2000, Number(props.charSpacing) || 0)),
        shadow:
          props.shadowBlur || props.shadowOffset
            ? new fabric.Shadow({
                color: props.shadowColor,
                blur: Number(props.shadowBlur),
                offsetX: Number(props.shadowOffset),
                offsetY: Number(props.shadowOffset),
              })
            : null,
      });
    } else if (o.type !== 'image') o.set('fill', props.fill);
    o.setCoords();
  });
}
function textAt(point: { x: number; y: number }) {
  mutate(() => {
    const text = new fabric.IText('双击编辑文字', {
      left: point.x,
      top: point.y,
      fontFamily: 'sans-serif',
      fontSize: 52,
      fill: '#375e4d',
      id: uid(),
      name: '文字',
    } as any);
    canvas.add(text);
    canvas.setActiveObject(text);
    tool.value = 'select';
    canvas.defaultCursor = 'default';
    canvas.selection = true;
    canvas.skipTargetFind = false;
  });
}
function chooseText() {
  tab.value = 'text';
  tool.value = 'text';
  canvas.discardActiveObject();
  canvas.defaultCursor = 'crosshair';
  canvas.selection = false;
  canvas.skipTargetFind = true;
  updateSelection();
  canvas.requestRenderAll();
}
function chooseSelect() {
  tool.value = 'select';
  canvas.defaultCursor = 'default';
  canvas.selection = true;
  canvas.skipTargetFind = false;
}
async function decode(data: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      image.naturalWidth * image.naturalHeight <= 40000000
        ? resolve(image)
        : reject(new Error('图片超过 4000 万像素，请缩小后上传。'));
    image.onerror = () => reject(new Error('图片无法读取，请使用有效的 PNG、JPEG 或 WebP。'));
    image.src = data;
  });
}
async function readAsset(file: File, kind: Asset['kind']) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('仅支持 PNG、JPEG 和 WebP 图片。');
  if (file.size > 20 * 1024 * 1024) throw new Error('单张图片请小于 20 MB。');
  const data = String(await getImgStr(file));
  const image = await decode(data);
  const existing = project.value.assets.find((a) => a.data === data && a.kind === kind);
  if (existing) return existing;
  if (
    project.value.assets.reduce((sum, item) => sum + item.data.length, 0) + data.length >
    100 * 1024 * 1024
  )
    throw new Error('项目图片总量已超过 100 MB，请另建项目。');
  if (project.value.assets.length >= 200) throw new Error('共享资产库最多保存 200 张图片。');
  const asset: Asset = {
    id: uid(),
    name: file.name,
    data,
    width: image.naturalWidth,
    height: image.naturalHeight,
    kind,
  };
  project.value.assets.push(asset);
  return asset;
}
async function upload(event: Event, replacing = false) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  await run(async () => {
    for (const file of files) {
      const asset = await readAsset(file, tab.value === 'material' ? 'material' : 'product');
      if (replacing) await placeAsset(asset, true);
    }
    snapshot();
    refreshLayers();
    updateSelection();
    remember();
    persist();
    notify(
      replacing
        ? '图片已替换，原始素材仍保留在资产库。'
        : '已加入共享资产库，点击图片即可放入当前画布。'
    );
  });
}
async function placeAsset(asset: Asset, replacing = false) {
  const old = canvas.getActiveObject() as any;
  if (replacing && (!old || old.locked || !(old.type === 'image' || old.slot)))
    throw new Error('请先选中未锁定的图片或产品占位框。');
  const element = await decode(asset.data);
  const image = new fabric.Image(element, {
    id: uid(),
    assetId: asset.id,
    name: asset.name,
    left: current.value.width * 0.25,
    top: current.value.height * 0.25,
  } as any);
  const maxW = replacing ? old.getScaledWidth() : current.value.width * 0.45;
  const maxH = replacing ? old.getScaledHeight() : current.value.height * 0.4;
  const ratio = Math.min(maxW / asset.width, maxH / asset.height);
  image.scale(ratio);
  image.set({ lockScalingFlip: true });
  if (replacing) {
    const center = old.getCenterPoint();
    image.set({
      id: old.id,
      name: old.slot ? old.name.replace(' · 选中后替换图片', ` · ${asset.name}`) : old.name,
      angle: old.angle,
      originX: 'center',
      originY: 'center',
      left: center.x,
      top: center.y,
    });
    const index = canvas.getObjects().indexOf(old);
    canvas.remove(old);
    canvas.add(image);
    canvas.moveTo(image, index);
  } else canvas.add(image);
  chooseSelect();
  canvas.setActiveObject(image);
  canvas.requestRenderAll();
}
async function addAsset(asset: Asset, replacing = false) {
  await run(async () => {
    await placeAsset(asset, replacing);
    snapshot();
    refreshLayers();
    updateSelection();
    remember();
    persist();
  });
}
function addDecoration(type: string) {
  mutate(() => {
    const config = {
      left: 100,
      top: 100,
      fill: '#e78269',
      id: uid(),
      name: type === 'circle' ? '装饰 · 圆形' : '装饰 · 圆角标签',
    };
    const o =
      type === 'circle'
        ? new fabric.Circle({ ...config, radius: 60 } as any)
        : new fabric.Rect({ ...config, width: 240, height: 80, rx: 16, ry: 16 } as any);
    canvas.add(o);
    canvas.setActiveObject(o);
  });
}
async function useTemplate(index: number) {
  await run(async () => {
    if (project.value.pages.length >= 30) throw new Error('每个项目最多 30 页。');
    snapshot();
    const page = templatePage(index);
    project.value.pages.push(page);
    project.value.activePageId = page.id;
    await loadScene(page);
    remember();
    persist();
    notify('模板已添加为新页面。选中产品位后，点击资产下的“替换选中”。');
  });
}
function resizePage() {
  const width = Number(size.width),
    height = Number(size.height);
  if (!dimensionsOK(width, height))
    return notify('尺寸需为 100–4096 的整数，且总像素不超过 1600 万。', true);
  mutate(() => {
    current.value.width = width;
    current.value.height = height;
    fit();
  });
}
function preset(width: number, height: number) {
  size.width = width;
  size.height = height;
  resizePage();
}
function background(event: Event) {
  mutate(() =>
    canvas.setBackgroundColor((event.target as HTMLInputElement).value, () =>
      canvas.requestRenderAll()
    )
  );
}
async function saveNow() {
  snapshot();
  persist();
  await saveQueue;
}
function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  downFile(url, name);
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function exportProject() {
  await run(async () => {
    snapshot();
    const data = validateProject(project.value);
    downloadBlob(
      new Blob([JSON.stringify(data)], { type: 'application/json' }),
      `${project.value.name || '扭蛋海报'}.gashapon.json`
    );
    persist();
    notify('完整项目已导出，包含全部页面及图片资产。');
  });
}
async function importProject(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = '';
  if (!file) return;
  await run(async () => {
    if (file.size > 150 * 1024 * 1024) throw new Error('项目文件不能超过 150 MB。');
    const data = validateProject(JSON.parse(await file.text()));
    for (const asset of data.assets) await decode(asset.data);
    if (!window.confirm('导入会替换当前项目。请先导出当前项目备份，是否继续？')) return;
    project.value = data;
    histories.clear();
    await loadScene(current.value);
    remember();
    persist();
    notify('完整项目导入成功，图片已随项目恢复。');
  });
}
async function exportPng() {
  await run(async () => {
    snapshot();
    const multiplier = Number(exportScale.value);
    if (current.value.width * current.value.height * multiplier * multiplier > 32000000)
      throw new Error('导出超过 3200 万像素，请降低倍率或画布尺寸。');
    // A separate StaticCanvas excludes selection, controls and editor overlays by construction.
    const output = new fabric.StaticCanvas(document.createElement('canvas'), {
      width: current.value.width,
      height: current.value.height,
      enableRetinaScaling: false,
    });
    try {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        output.loadFromJSON(hydrateScene(current.value, project.value.assets), () => resolve())
      );
      const url = output.toDataURL({ format: 'png', multiplier, enableRetinaScaling: false });
      downFile(url, `${project.value.name}-${current.value.name}.png`);
      notify(
        `PNG 已导出：${current.value.width * multiplier} × ${
          current.value.height * multiplier
        }，不含选框或辅助线。`
      );
    } finally {
      output.dispose();
    }
  });
}
function shortcuts(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (
    target.closest('input, textarea, select, [contenteditable="true"]') ||
    editingText() ||
    busy.value ||
    !ready.value
  )
    return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    historyMove(event.shiftKey ? 1 : -1);
  } else if (mod && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveNow();
  } else if (mod && event.key.toLowerCase() === 'd') {
    event.preventDefault();
    cloneSelected();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    removeSelected();
  } else if (event.key === 'Escape') chooseSelect();
}
onMounted(async () => {
  canvas = new fabric.Canvas(canvasEl.value!, {
    preserveObjectStacking: true,
    selection: true,
    uniformScaling: true,
    uniScaleKey: 'none',
    enableRetinaScaling: true,
    controlsAboveOverlay: true,
  });
  canvas.on('selection:created', updateSelection);
  canvas.on('selection:updated', updateSelection);
  canvas.on('selection:cleared', updateSelection);
  canvas.on('object:modified', changed);
  canvas.on('text:changed', changed);
  canvas.on('mouse:down', (event) => {
    if (tool.value === 'text' && !busy.value) textAt(canvas.getPointer(event.e));
  });
  observer = new ResizeObserver(fit);
  observer.observe(stage.value!);
  window.addEventListener('keydown', shortcuts);
  restoring = true;
  try {
    const saved = await readSavedProject();
    if (saved) project.value = saved;
  } catch {
    notify('无法恢复本机项目，已打开空白画布。原备份未覆盖；可从完整项目文件导入。', true);
  }
  try {
    await nextTick();
    await loadScene(current.value);
    remember();
    ready.value = true;
    status.value = '已就绪 · 更改后自动保存';
  } catch (e) {
    notify(`恢复失败：${String(e)}。请从完整项目备份重新导入。`, true);
    ready.value = true;
  } finally {
    restoring = false;
  }
});
onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  canvas?.dispose();
  window.removeEventListener('keydown', shortcuts);
});
</script>

<template>
  <div class="poster-app" :class="{ 'is-busy': busy }">
    <header class="poster-header">
      <div class="brand-mark">丸</div>
      <div class="brand">
        <strong>丸物设计室</strong>
        <span>日式扭蛋海报编辑器</span>
      </div>
      <div class="header-divider"></div>
      <input
        v-model="project.name"
        class="project-name"
        aria-label="项目名称"
        maxlength="80"
        :disabled="!ready || busy"
        @change="persist"
      />
      <span class="save-state" role="status">{{ status }}</span>
      <div class="header-actions">
        <button :disabled="!ready || busy" @click="saveNow">保存</button>
        <button :disabled="!ready || busy" @click="importInput?.click()">导入项目</button>
        <button :disabled="!ready || busy" @click="exportProject">导出项目</button>
        <button class="primary" :disabled="!ready || busy" @click="exportPng">导出 PNG ↗</button>
      </div>
    </header>
    <div v-if="message" class="notice" :class="{ error }" role="alert">
      <span>{{ message }}</span>
      <button aria-label="关闭提示" @click="message = ''">×</button>
    </div>
    <main class="editor-layout">
      <nav class="tool-rail" aria-label="创作工具">
        <button
          v-for="item in tabs"
          :key="item.id"
          :aria-label="item.name"
          :class="{ active: tab === item.id }"
          @click="tab = item.id"
        >
          <b>{{ item.icon }}</b>
          <span>{{ item.name }}</span>
        </button>
        <span class="rail-bottom">
          一期
          <br />
          本地创作
        </span>
      </nav>
      <aside class="asset-panel">
        <div class="panel-heading">
          <span>{{ tabs.find((t) => t.id === tab)?.name }}</span>
          <small>创作素材库</small>
        </div>
        <template v-if="tab === 'product' || tab === 'material'">
          <div class="section-intro">
            <h2>{{ tab === 'product' ? '让每一款，都成为主角。' : '为海报添一点趣味。' }}</h2>
            <p>图片保留在共享资产库，各页面均可使用。</p>
          </div>
          <button class="upload-card" :disabled="!ready || busy" @click="fileInput?.click()">
            <b>＋</b>
            <strong>{{ tab === 'product' ? '上传产品图' : '上传本地素材' }}</strong>
            <span>透明 PNG / JPEG / WebP · 单张 ≤20MB</span>
          </button>
          <p class="muted small">点击图片加入画布；删除对象不会删除原素材。</p>
          <div class="asset-grid">
            <article v-for="asset in assets" :key="asset.id" class="asset-card">
              <button
                class="asset-image checker"
                :disabled="busy"
                :aria-label="`添加图片 ${asset.name}`"
                @click="addAsset(asset)"
              >
                <img :src="asset.data" :alt="asset.name" />
              </button>
              <span :title="asset.name">{{ asset.name }}</span>
              <button
                class="text-button"
                :disabled="busy || selectedLocked || !(selectedType === 'image' || selectedSlot)"
                @click="addAsset(asset, true)"
              >
                替换选中
              </button>
            </article>
          </div>
          <div v-if="!assets.length" class="empty-state">
            <span>◈</span>
            <p>你的素材，将从这里开始</p>
            <small>上传后点击缩略图，即可自由排版</small>
          </div>
          <template v-if="tab === 'material'">
            <h3 class="section-label">基础装饰 · 独立可编辑</h3>
            <div class="decoration-buttons">
              <button :disabled="!ready || busy" @click="addDecoration('circle')">● 圆形</button>
              <button :disabled="!ready || busy" @click="addDecoration('rect')">▰ 标签</button>
            </div>
            <div class="offline-note">
              <b>在线素材暂不可用</b>
              <p>上游服务返回 403。本阶段使用本地素材，不影响上传、文字、保存和导出。</p>
            </div>
          </template>
        </template>
        <template v-else-if="tab === 'template'">
          <div class="section-intro">
            <h2>小小收藏，大大心动。</h2>
            <p>为 3–6 款产品准备的基础版式。点击添加为新页面，不覆盖当前作品。</p>
          </div>
          <button
            v-for="(t, index) in templates"
            :key="t.count"
            class="template-card"
            :disabled="!ready || busy"
            @click="useTemplate(index)"
          >
            <div class="template-mini" :style="{ background: t.bg, color: t.ink }">
              <small>GASHAPON COLLECTION</small>
              <strong>{{ t.title }}</strong>
              <div
                class="mini-slots"
                :style="{ gridTemplateColumns: `repeat(${t.count <= 4 ? 2 : 3}, 1fr)` }"
              >
                <i v-for="n in t.count" :key="n" :style="{ borderColor: t.accent }">
                  {{ String(n).padStart(2, '0') }}
                </i>
              </div>
              <span>全 {{ t.count }} 款 · 小さなしあわせ</span>
            </div>
            <div class="template-caption">
              <strong>{{ t.title }}</strong>
              <span>{{ t.subtitle }} ＋</span>
            </div>
          </button>
          <p class="muted small">
            产品位、款名、标题和每个装饰均可单独编辑。选择产品位后，在产品图库点击“替换选中”。
          </p>
        </template>
        <template v-else-if="tab === 'text'">
          <div class="section-intro">
            <h2>用文字，写下心动。</h2>
            <p>选择工具 → 点击画布添加 → 双击文字编辑。</p>
          </div>
          <button
            class="text-tool"
            :class="{ chosen: tool === 'text' }"
            :disabled="!ready || busy"
            @click="chooseText"
          >
            <b>T</b>
            <span>
              文字工具
              <small>点击画布放置文字</small>
            </span>
            <i>＋</i>
          </button>
          <button class="wide-button" :disabled="!ready || busy" @click="chooseSelect">
            ↖ 返回选择工具
          </button>
          <div class="help-card">
            <b>排版小提示</b>
            <p>双击画布文字可直接输入。右侧可调整字体、字号、描边、阴影、行距与字距。</p>
            <p>文字内容会随项目保存。不同电脑的系统字体可能略有差异。</p>
          </div>
        </template>
        <template v-else>
          <div class="section-intro">
            <span class="coming-soon">尚未接入</span>
            <h2>灵感，下一站见。</h2>
            <p>AI 找素材 · 扩展预留</p>
          </div>
          <div class="help-card">
            <p>描述你的想法，扩展中、英、日关键词，检索真实素材并进行视觉筛选。</p>
            <ol>
              <li>自然语言需求</li>
              <li>中 / 英 / 日关键词扩展</li>
              <li>真实素材检索与来源授权</li>
              <li>视觉筛选与人工选择</li>
            </ol>
          </div>
          <textarea
            disabled
            placeholder="例如：温暖复古的日式喫茶店，奶油绿与砖红色…"
            aria-label="AI 素材需求（尚未接入）"
          ></textarea>
          <button class="wide-button" disabled>
            {{ materialSearchProvider ? '搜索素材' : 'AI 找素材 · 尚未接入' }}
          </button>
        </template>
      </aside>
      <section class="canvas-area">
        <div class="canvas-toolbar">
          <div>
            <button
              aria-label="选择工具"
              :class="{ selected: tool === 'select' }"
              :disabled="!ready || busy"
              @click="chooseSelect"
            >
              ↖
            </button>
            <button
              aria-label="撤销"
              title="撤销 Ctrl/⌘ Z"
              :disabled="!canUndo || busy"
              @click="historyMove(-1)"
            >
              ↶
            </button>
            <button
              aria-label="重做"
              title="重做 Ctrl/⌘ Shift Z"
              :disabled="!canRedo || busy"
              @click="historyMove(1)"
            >
              ↷
            </button>
            <span class="toolbar-separator"></span>
            <button :disabled="!selectedId || selectedLocked || busy" @click="cloneSelected">
              复制
            </button>
            <button :disabled="!selectedId || selectedLocked || busy" @click="removeSelected">
              删除
            </button>
          </div>
          <span>
            {{ current.width }} × {{ current.height }} px
            <i>·</i>
            {{ Math.round(scale * 100) }}%
          </span>
        </div>
        <div ref="stage" class="stage" :class="{ 'text-cursor': tool === 'text' }">
          <div class="paper"><canvas ref="canvasEl"></canvas></div>
          <div v-if="!ready || busy" class="loading-overlay">
            {{ ready ? '正在处理…' : '正在恢复项目…' }}
          </div>
        </div>
        <div class="canvas-footer">
          <span>
            {{
              tool === 'text'
                ? '文字工具已选中 · 点击画布放置文字，Esc 退出'
                : '拖动排版 · 角点等比缩放 · 顶部控制点旋转 · 双击编辑文字'
            }}
          </span>
          <label>
            PNG 倍率
            <select v-model="exportScale" aria-label="PNG 导出倍率">
              <option :value="1">1× 原尺寸</option>
              <option :value="2">2× 高清</option>
              <option :value="3">3× 超清</option>
            </select>
          </label>
        </div>
        <div class="pages-strip">
          <span class="pages-label">页面</span>
          <button
            v-for="(page, index) in project.pages"
            :key="page.id"
            :class="{ current: current.id === page.id }"
            :disabled="busy"
            @click="switchPage(page.id)"
          >
            <small>{{ String(index + 1).padStart(2, '0') }}</small>
            {{ page.name }}
          </button>
          <button :disabled="!ready || busy" @click="addPage()">＋ 新页面</button>
          <button :disabled="!ready || busy" @click="addPage(true)">复制页</button>
          <button
            aria-label="删除当前页面"
            :disabled="project.pages.length === 1 || busy"
            @click="deletePage"
          >
            删除页
          </button>
        </div>
      </section>
      <aside class="inspector">
        <div class="panel-heading">
          <span>画布设置</span>
          <small>当前页面</small>
        </div>
        <div class="inspector-block">
          <label>
            页面名称
            <input
              v-model="current.name"
              aria-label="页面名称"
              maxlength="80"
              :disabled="busy"
              @change="persist"
            />
          </label>
          <div class="preset-buttons">
            <button :disabled="busy" @click="preset(900, 1200)">3:4 竖版</button>
            <button :disabled="busy" @click="preset(1200, 900)">4:3 横版</button>
          </div>
          <div class="fields-row">
            <label>
              宽度 px
              <input
                v-model.number="size.width"
                aria-label="画布宽度"
                type="number"
                min="100"
                max="4096"
                :disabled="busy"
              />
            </label>
            <span>×</span>
            <label>
              高度 px
              <input
                v-model.number="size.height"
                aria-label="画布高度"
                type="number"
                min="100"
                max="4096"
                :disabled="busy"
              />
            </label>
            <button class="apply-size" :disabled="busy" @click="resizePage">应用</button>
          </div>
          <label class="color-row">
            背景颜色
            <input
              type="color"
              aria-label="画布背景颜色"
              :value="current.scene.background"
              :disabled="busy"
              @change="background"
            />
          </label>
        </div>
        <div class="panel-heading">
          <span>对象属性</span>
          <small>
            {{
              selectedType.includes('text')
                ? '文字'
                : selectedType === 'image'
                ? '图片'
                : selectedId
                ? '装饰'
                : '未选择'
            }}
          </small>
        </div>
        <div v-if="selectedId" class="inspector-block property-fields">
          <p v-if="selectedLocked" class="muted">该图层已锁定，请先在图层列表解锁。</p>
          <fieldset :disabled="busy || selectedLocked">
            <label>
              对象名称
              <input v-model="props.name" aria-label="对象名称" @change="applyProps" />
            </label>
            <template v-if="selectedType.includes('text')">
              <label>
                文字内容
                <textarea
                  v-model="props.text"
                  aria-label="文字内容"
                  maxlength="10000"
                  @change="applyProps"
                ></textarea>
              </label>
              <label>
                字体
                <select v-model="props.fontFamily" aria-label="字体" @change="applyProps">
                  <option v-for="font in fonts" :key="font.value" :value="font.value">
                    {{ font.label }}
                  </option>
                </select>
              </label>
              <div class="fields-row">
                <label>
                  字号
                  <input
                    v-model.number="props.fontSize"
                    aria-label="字号"
                    type="number"
                    min="8"
                    max="500"
                    @change="applyProps"
                  />
                </label>
                <label class="color-row">
                  颜色
                  <input
                    v-model="props.fill"
                    aria-label="文字颜色"
                    type="color"
                    @change="applyProps"
                  />
                </label>
              </div>
              <div class="fields-row">
                <label>
                  描边 px
                  <input
                    v-model.number="props.strokeWidth"
                    aria-label="描边宽度"
                    type="number"
                    min="0"
                    max="30"
                    @change="applyProps"
                  />
                </label>
                <label class="color-row">
                  描边色
                  <input
                    v-model="props.stroke"
                    aria-label="描边颜色"
                    type="color"
                    @change="applyProps"
                  />
                </label>
              </div>
              <div class="fields-row">
                <label>
                  行距倍数
                  <input
                    v-model.number="props.lineHeight"
                    aria-label="行距"
                    type="number"
                    min="0.5"
                    max="4"
                    step="0.1"
                    @change="applyProps"
                  />
                </label>
                <label>
                  字距 1/1000 em
                  <input
                    v-model.number="props.charSpacing"
                    aria-label="字距"
                    type="number"
                    min="-200"
                    max="2000"
                    step="10"
                    @change="applyProps"
                  />
                </label>
              </div>
              <div class="fields-row">
                <label>
                  阴影模糊
                  <input
                    v-model.number="props.shadowBlur"
                    aria-label="阴影模糊"
                    type="number"
                    min="0"
                    max="100"
                    @change="applyProps"
                  />
                </label>
                <label>
                  阴影偏移
                  <input
                    v-model.number="props.shadowOffset"
                    aria-label="阴影偏移"
                    type="number"
                    min="-100"
                    max="100"
                    @change="applyProps"
                  />
                </label>
                <label class="color-row">
                  色
                  <input
                    v-model="props.shadowColor"
                    aria-label="阴影颜色"
                    type="color"
                    @change="applyProps"
                  />
                </label>
              </div>
            </template>
            <label v-else-if="selectedType !== 'image'" class="color-row">
              填充颜色
              <input v-model="props.fill" aria-label="填充颜色" type="color" @change="applyProps" />
            </label>
            <label>
              旋转角度
              <input
                v-model.number="props.angle"
                aria-label="旋转角度"
                type="number"
                @change="applyProps"
              />
            </label>
            <button
              v-if="selectedType === 'image' || selectedSlot"
              class="wide-button"
              @click="replaceInput?.click()"
            >
              上传并替换选中图片
            </button>
          </fieldset>
        </div>
        <p v-else class="property-empty">
          选择画布对象，开始编辑
          <br />
          <small>图片、文字和装饰均可独立调整</small>
        </p>
        <div class="panel-heading">
          <span>
            图层
            <small>{{ layers.length }}</small>
          </span>
          <div>
            <button aria-label="图层上移" :disabled="!selectedId || busy" @click="moveLayer(1)">
              ↑
            </button>
            <button aria-label="图层下移" :disabled="!selectedId || busy" @click="moveLayer(-1)">
              ↓
            </button>
          </div>
        </div>
        <p class="layer-hint">上方图层覆盖下方 · 拖动 ☷ 排序</p>
        <div class="layer-list">
          <div
            v-for="layer in layers"
            :key="layer.id"
            class="layer-row"
            :class="{ active: selectedId === layer.id, hidden: !layer.visible }"
            :data-layer-id="layer.id"
            :draggable="!busy"
            @dragstart="startDrag(layer.id, $event)"
            @dragover.prevent
            @drop.prevent.stop="reorder(layer.id, $event)"
            @click="selectLayer(layer.id)"
          >
            <span class="drag-handle" draggable="true" title="拖动排序">☷</span>
            <span class="layer-icon">
              {{ layer.type.includes('text') ? 'T' : layer.type === 'image' ? '◈' : '◇' }}
            </span>
            <input
              :value="layer.name"
              aria-label="图层名称"
              :disabled="busy"
              @click.stop="selectLayer(layer.id)"
              @change="renameLayer(layer.id, $event)"
            />
            <button
              :aria-label="layer.visible ? '隐藏图层' : '显示图层'"
              :disabled="busy"
              @click.stop="layerAction(layer.id, 'hide')"
            >
              {{ layer.visible ? '◉' : '○' }}
            </button>
            <button
              :aria-label="layer.locked ? '解锁图层' : '锁定图层'"
              :disabled="busy"
              @click.stop="layerAction(layer.id, 'lock')"
            >
              {{ layer.locked ? '锁' : '开' }}
            </button>
            <button
              aria-label="删除图层"
              :disabled="busy"
              @click.stop="layerAction(layer.id, 'delete')"
            >
              ×
            </button>
          </div>
          <p v-if="!layers.length" class="property-empty">
            画布还是空的
            <br />
            <small>上传产品图，或从模板开始</small>
          </p>
        </div>
      </aside>
    </main>
    <input
      ref="fileInput"
      class="file-input"
      data-testid="upload-assets"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple
      @change="upload($event)"
    />
    <input
      ref="replaceInput"
      class="file-input"
      data-testid="replace-image"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      @change="upload($event, true)"
    />
    <input
      ref="importInput"
      class="file-input"
      data-testid="import-project"
      type="file"
      accept=".json,.gashapon.json"
      @change="importProject"
    />
  </div>
</template>

<style scoped>
.poster-app {
  --green: #375e4d;
  --ink: #283c32;
  --muted: #7b8179;
  --line: #e6e6dc;
  height: 100vh;
  min-height: 650px;
  min-width: 1050px;
  display: flex;
  flex-direction: column;
  background: #fafbf6;
  color: var(--ink);
  font-family: 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif;
  font-size: 12px;
}
* {
  box-sizing: border-box;
}
button,
input,
textarea,
select {
  font: inherit;
}
button {
  cursor: pointer;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  color: var(--ink);
  padding: 7px 11px;
  transition: background 0.15s;
}
button:hover:not(:disabled) {
  background: #edf2e9;
  border-color: #b4c4b5;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
input,
textarea,
select {
  border: 1px solid #dedfd5;
  border-radius: 5px;
  background: #fff;
  color: var(--ink);
  padding: 7px;
  width: 100%;
  min-width: 0;
}
input:focus,
textarea:focus,
select:focus {
  outline: 2px solid #a9bc9b;
  outline-offset: 1px;
}
input[type='color'] {
  width: 34px;
  height: 29px;
  padding: 3px;
  cursor: pointer;
}
textarea {
  resize: vertical;
  min-height: 64px;
}
label {
  display: block;
  color: #73796f;
  font-size: 11px;
}
label input,
label textarea,
label select {
  margin-top: 5px;
}
h2 {
  font-size: 18px;
  line-height: 1.65;
  letter-spacing: -0.5px;
  font-weight: 600;
  margin: 0 0 10px;
}
p {
  line-height: 1.8;
}
fieldset {
  padding: 0;
  margin: 0;
  border: 0;
  min-width: 0;
}
.primary {
  background: var(--green);
  color: #fff;
  border-color: var(--green);
}
.primary:hover:not(:disabled) {
  background: #274b39;
  color: white;
}
.poster-header {
  display: flex;
  align-items: center;
  gap: 13px;
  min-height: 78px;
  padding: 0 24px;
  border-bottom: 1px solid var(--line);
  background: #fffef8;
}
.brand-mark {
  width: 39px;
  height: 42px;
  display: grid;
  place-items: center;
  color: #fff9e8;
  background: var(--green);
  border-radius: 9px 9px 16px 16px;
  font-family: serif;
  font-size: 25px;
}
.brand {
  min-width: 145px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.brand strong {
  font-family: serif;
  font-size: 19px;
  letter-spacing: 3px;
}
.brand span {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 1px;
}
.header-divider {
  height: 28px;
  width: 1px;
  background: var(--line);
  margin: 0 8px;
}
.project-name {
  border: 0;
  width: 170px;
  font-weight: 600;
  background: transparent;
  font-size: 13px;
}
.save-state {
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
}
.header-actions {
  margin-left: auto;
  display: flex;
  gap: 7px;
  white-space: nowrap;
}
.notice {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 24px;
  background: #eaf0df;
  border-bottom: 1px solid #cad8b9;
  font-size: 12px;
}
.notice.error {
  background: #fff0df;
  color: #9b3e2d;
  border-color: #efd3ba;
}
.notice button {
  border: 0;
  background: none;
  padding: 0 5px;
  font-size: 18px;
}
.editor-layout {
  display: flex;
  flex: 1;
  min-height: 0;
}
.tool-rail {
  width: 75px;
  flex-shrink: 0;
  border-right: 1px solid var(--line);
  background: #fffef8;
  padding: 18px 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tool-rail button {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 13px 0;
  background: transparent;
  border: 0;
  color: #798074;
  font-size: 11px;
}
.tool-rail b {
  font-size: 22px;
  font-weight: 400;
  line-height: 1;
}
.tool-rail button.active {
  background: #eaf0e3;
  color: var(--green);
}
.rail-bottom {
  margin-top: auto;
  text-align: center;
  font-size: 10px;
  line-height: 1.8;
  color: #a1a797;
}
.asset-panel {
  width: 262px;
  flex-shrink: 0;
  background: #fffef9;
  border-right: 1px solid var(--line);
  overflow-y: auto;
  padding: 0 18px 20px;
}
.panel-heading {
  min-height: 49px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}
.panel-heading small {
  font-size: 10px;
  color: #94988c;
  font-weight: 400;
  margin-left: 4px;
}
.panel-heading button {
  padding: 2px 7px;
  border: 0;
  background: transparent;
}
.section-intro {
  padding: 24px 0 12px;
}
.section-intro p {
  font-size: 11px;
  color: var(--muted);
  margin: 0;
}
.upload-card {
  width: 100%;
  border: 1px dashed #acb99f;
  background: #f4f6ed;
  display: flex;
  align-items: center;
  flex-direction: column;
  padding: 22px 8px;
  gap: 8px;
  border-radius: 9px;
}
.upload-card b {
  width: 30px;
  height: 30px;
  font-size: 23px;
  line-height: 28px;
  background: #e4ebd9;
  color: var(--green);
  border-radius: 50%;
  font-weight: 400;
}
.upload-card span {
  font-size: 9px;
  color: #929889;
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 10px;
}
.asset-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 10px;
  margin-top: 16px;
}
.asset-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.asset-image {
  width: 100%;
  height: 95px;
  padding: 9px;
  overflow: hidden;
}
.asset-image img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.asset-card > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
}
.checker {
  background-color: #fff;
  background-image: linear-gradient(45deg, #eee 25%, transparent 25%),
    linear-gradient(-45deg, #eee 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #eee 75%),
    linear-gradient(-45deg, transparent 75%, #eee 75%);
  background-size: 12px 12px;
  background-position: 0 0, 0 6px, 6px -6px, -6px 0;
}
.text-button {
  font-size: 10px;
  padding: 4px;
}
.empty-state {
  text-align: center;
  color: #9ca28f;
  padding: 45px 0;
}
.empty-state > span {
  display: block;
  font-size: 35px;
  color: #c9d0bd;
}
.empty-state p {
  font-size: 12px;
  margin: 10px 0 4px;
}
.empty-state small {
  font-size: 10px;
}
.section-label {
  font-size: 12px;
  border-top: 1px solid var(--line);
  padding-top: 18px;
  margin-top: 22px;
}
.decoration-buttons,
.preset-buttons {
  display: flex;
  gap: 8px;
  margin: 12px 0;
}
.decoration-buttons button,
.preset-buttons button {
  flex: 1;
}
.offline-note,
.help-card {
  background: #f2f3ea;
  border-radius: 7px;
  padding: 15px;
  margin-top: 20px;
  font-size: 11px;
  color: #747b6a;
}
.offline-note p {
  margin-bottom: 0;
}
.help-card ol {
  padding-left: 18px;
  line-height: 2.3;
}
.template-card {
  width: 100%;
  padding: 0;
  margin: 0 0 16px;
  overflow: hidden;
  text-align: left;
  background: #fffef9;
}
.template-mini {
  padding: 18px 22px;
  height: 246px;
  position: relative;
  display: flex;
  flex-direction: column;
  border: 8px solid #ffffff55;
}
.template-mini small {
  font-size: 7px;
  letter-spacing: 1.8px;
}
.template-mini > strong {
  font-family: serif;
  font-size: 32px;
  letter-spacing: 3px;
  margin: 9px 0 12px;
}
.mini-slots {
  display: grid;
  gap: 8px;
  flex: 1;
}
.mini-slots i {
  border: 1px dashed;
  border-radius: 9px;
  display: grid;
  place-items: center;
  background: #ffffff90;
  font-style: normal;
  font-size: 10px;
}
.template-mini > span {
  font-size: 7px;
  letter-spacing: 1px;
  margin-top: 12px;
}
.template-caption {
  padding: 11px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.template-caption strong {
  font-size: 12px;
}
.template-caption span {
  font-size: 9px;
  color: #858b7a;
}
.text-tool {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 16px;
  padding: 18px;
  text-align: left;
}
.text-tool > b {
  font-family: serif;
  font-size: 37px;
}
.text-tool span {
  flex: 1;
  font-weight: 600;
}
.text-tool small {
  display: block;
  font-weight: 400;
  margin-top: 5px;
  font-size: 10px;
  color: var(--muted);
}
.text-tool i {
  font-size: 20px;
  font-style: normal;
}
.chosen {
  border-color: var(--green);
  background: #eaf0e3;
}
.wide-button {
  width: 100%;
  margin-top: 10px;
}
.coming-soon {
  font-size: 10px;
  border: 1px solid #c9cebb;
  padding: 3px 7px;
  border-radius: 4px;
  display: inline-block;
  margin-bottom: 18px;
  color: #819070;
}
.canvas-area {
  flex: 1;
  min-width: 320px;
  display: flex;
  flex-direction: column;
  background: #e9ebe3;
}
.canvas-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 49px;
  padding: 0 16px;
  background: #f6f7f0;
  border-bottom: 1px solid #dee2d5;
  color: #7c8374;
  font-size: 10px;
}
.canvas-toolbar > div {
  display: flex;
  align-items: center;
  gap: 5px;
}
.canvas-toolbar button {
  background: transparent;
  border: 0;
  padding: 5px 8px;
}
.canvas-toolbar button.selected {
  color: var(--green);
  background: #e2e9d9;
}
.toolbar-separator {
  height: 16px;
  border-left: 1px solid #d5dbca;
  margin: 0 4px;
}
.canvas-toolbar i {
  padding: 0 6px;
  font-style: normal;
}
.stage {
  flex: 1;
  min-height: 200px;
  overflow: hidden;
  display: flex;
  justify-content: center;
  align-items: center;
  position: relative;
  background-image: radial-gradient(#cbd0c0 0.7px, transparent 0.7px);
  background-size: 16px 16px;
}
.paper {
  box-shadow: 0 6px 28px #394c3324, 0 1px 3px #394c3317;
  line-height: 0;
}
.loading-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: #e9ebe3b8;
  z-index: 10;
  backdrop-filter: blur(2px);
}
.canvas-footer {
  min-height: 37px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  color: #8a907f;
  font-size: 9px;
  gap: 10px;
}
.canvas-footer label {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  font-size: 10px;
}
.canvas-footer select {
  margin: 0;
  width: 95px;
  padding: 3px;
  font-size: 10px;
  background: transparent;
}
.pages-strip {
  min-height: 73px;
  display: flex;
  gap: 8px;
  align-items: center;
  overflow-x: auto;
  padding: 12px 16px;
  border-top: 1px solid #d9dece;
  background: #f6f7ef;
  flex-shrink: 0;
}
.pages-strip button {
  white-space: nowrap;
  font-size: 10px;
  padding: 9px 11px;
  background: #fffef9;
}
.pages-strip button.current {
  border-color: var(--green);
  color: var(--green);
  box-shadow: inset 0 0 0 1px var(--green);
}
.pages-strip small {
  font-size: 9px;
  color: #9ba48c;
  margin-right: 7px;
}
.pages-label {
  font-size: 10px;
  color: #8e9683;
  margin-right: 5px;
}
.inspector {
  width: 278px;
  flex-shrink: 0;
  background: #fffef9;
  overflow-y: auto;
  border-left: 1px solid var(--line);
  padding: 0 16px 20px;
}
.inspector-block {
  padding: 13px 0 16px;
}
.inspector-block > label,
fieldset > label {
  margin-bottom: 10px;
}
.fields-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 8px 0 12px;
}
.fields-row > label {
  flex: 1;
  min-width: 0;
}
.fields-row > span {
  color: #a5ab98;
  margin-top: 20px;
  font-size: 10px;
}
.apply-size {
  padding: 7px;
  margin-top: 20px;
  font-size: 10px;
}
.color-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.color-row input {
  margin: 0;
  flex-shrink: 0;
}
.fields-row .color-row {
  flex: 0 0 auto;
  margin-top: 17px;
}
.property-empty {
  font-size: 11px;
  color: #a1a691;
  text-align: center;
  line-height: 2;
  margin: 27px 0;
}
.property-empty small {
  font-size: 10px;
}
.layer-hint {
  font-size: 9px;
  color: #9ba08e;
  margin: 10px 0;
}
.layer-list {
  padding-bottom: 10px;
}
.layer-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 3px;
  border: 1px solid transparent;
  border-bottom-color: #eeeee5;
  cursor: pointer;
  border-radius: 4px;
}
.layer-row.active {
  background: #eaf0e1;
  border-color: #d2dfc4;
}
.layer-row.hidden {
  opacity: 0.55;
}
.drag-handle {
  color: #b6bca9;
  cursor: grab;
}
.layer-icon {
  font-size: 13px;
  color: #7b896d;
  padding: 0 4px;
}
.layer-row input {
  border: 0;
  background: transparent;
  font-size: 10px;
  padding: 4px 0;
  flex: 1;
  width: 40px;
}
.layer-row button {
  padding: 3px;
  font-size: 10px;
  background: transparent;
  border: 0;
  color: #818a73;
}
.file-input {
  display: none;
}
@media (min-width: 1600px) {
  .asset-panel {
    width: 290px;
    padding-left: 24px;
    padding-right: 24px;
  }
  .inspector {
    width: 300px;
    padding-left: 22px;
    padding-right: 22px;
  }
}
</style>
