import { fabric } from 'fabric';
import { uid, type PosterPage } from './project';

export const templates = [
  {
    count: 3,
    title: '春日收藏',
    subtitle: '奶油纸感 · 三款限定',
    bg: '#fff8e8',
    ink: '#375e4d',
    accent: '#e78269',
  },
  {
    count: 4,
    title: '喫茶日和',
    subtitle: '复古喫茶 · 四款精选',
    bg: '#f9eed8',
    ink: '#653e31',
    accent: '#ba483c',
  },
  {
    count: 5,
    title: '星屑放送',
    subtitle: '夜空蓝调 · 五款奇遇',
    bg: '#e9eef8',
    ink: '#303b69',
    accent: '#dd9a4c',
  },
  {
    count: 6,
    title: '小小百货',
    subtitle: '昭和商店 · 六款集结',
    bg: '#f5f1dc',
    ink: '#344b43',
    accent: '#dc6a49',
  },
];
/** Every title, name, product slot and ornament is an independent Fabric object. */
export function templatePage(index: number): PosterPage {
  const t = templates[index];
  const objects: fabric.Object[] = [];
  function add(o: fabric.Object, name: string, extra = {}) {
    o.set({ id: uid(), name, ...extra } as any);
    objects.push(o);
  }
  function text(value: string, x: number, y: number, size: number, name: string, color = t.ink) {
    add(
      new fabric.IText(value, {
        left: x,
        top: y,
        fontFamily: 'sans-serif',
        fontSize: size,
        fill: color,
        fontWeight: 'bold',
      }),
      name
    );
  }
  add(
    new fabric.Rect({
      left: 30,
      top: 30,
      width: 840,
      height: 1140,
      fill: 'transparent',
      stroke: t.ink,
      strokeWidth: 3,
      rx: 22,
      ry: 22,
    }),
    '装饰 · 外框'
  );
  text('G A S H A P O N   C O L L E C T I O N', 90, 72, 20, '装饰 · 顶部小字');
  text(t.title, 85, 115, 90, '海报标题');
  text('把小小的快乐，装进口袋。', 92, 235, 25, '副标题');
  add(
    new fabric.Rect({ left: 90, top: 295, width: 720, height: 5, fill: t.accent }),
    '装饰 · 分隔线'
  );
  const cols = t.count <= 4 ? 2 : 3;
  const rows = Math.ceil(t.count / cols);
  const cellW = 720 / cols,
    cellH = 650 / rows;
  for (let i = 0; i < t.count; i++) {
    const col = i % cols,
      row = Math.floor(i / cols);
    const offset = t.count === 3 && i === 2 ? cellW / 2 : 0;
    const x = 90 + col * cellW + offset,
      y = 340 + row * cellH;
    add(
      new fabric.Circle({ left: x + 8, top: y + 8, radius: 20, fill: t.accent }),
      `装饰 · 编号底 ${i + 1}`
    );
    text(String(i + 1).padStart(2, '0'), x + 15, y + 13, 19, `装饰 · 编号 ${i + 1}`, '#ffffff');
    add(
      new fabric.Rect({
        left: x + 48,
        top: y + 38,
        width: cellW - 80,
        height: cellH - 112,
        fill: '#ffffff',
        stroke: t.accent,
        strokeWidth: 2,
        strokeDashArray: [7, 6],
        rx: 24,
        ry: 24,
      }),
      `产品位 ${i + 1} · 选中后替换图片`,
      { slot: true }
    );
    text(`款式 ${String(i + 1).padStart(2, '0')}`, x + 58, y + cellH - 58, 25, `款式名称 ${i + 1}`);
  }
  text(`全 ${t.count} 款  /  自由搭配收藏`, 92, 1050, 30, '底部说明');
  text('小さなしあわせ  ·  每一款都值得期待', 92, 1110, 20, '装饰 · 底部小字');
  add(new fabric.Circle({ left: 710, top: 155, radius: 44, fill: t.accent }), '装饰 · 圆章');
  text('新品', 722, 179, 30, '装饰 · 圆章文字', '#ffffff');
  return {
    id: uid(),
    name: `${t.title} · ${t.count}款`,
    width: 900,
    height: 1200,
    scene: {
      version: fabric.version,
      objects: objects.map((o) => o.toObject(['id', 'name', 'slot'])),
      background: t.bg,
    },
  };
}
