// radar-chart.js — 零依赖 canvas 雷达图（AI 能力诊断）
// drawRadar(canvas, { labels, values, lineValues, met })
//   labels:      轴名数组（6 个模块名；>4 字自动换行）
//   values:      实际正确率 0–1（实线多边形）
//   lineValues:  达标线 0–1（虚线多边形）
//   met:         达标轴 boolean[]（true 的轴顶点描边置亮为绿）
// 颜色随主题：getComputedStyle(canvas) 读 CSS 变量（--primary/--text-2/--text-3/--card/--border/--green/--accent）
//   —— 深色/浅色在 style.css 的 :root 与 [data-theme=dark] 下重定义，读取即自动适配。
// 零依赖：只使用 canvas 2D API；窗口 resize 重绘由调用方监听（本模块每次 drawRadar 按当前容器尺寸重建）。

export function drawRadar(canvas, opts = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const labels = opts.labels || [];
  const n = labels.length;
  if (!n) return;

  const ctx = canvas.getContext('2d');
  const cs = getComputedStyle(canvas);
  const cssVar = (name, fallback) => {
    const v = cs.getPropertyValue(name);
    return (v && v.trim()) || fallback;
  };
  const primary = cssVar('--primary', '#14508d');
  const text2 = cssVar('--text-2', 'rgba(16,35,56,.62)');
  const text3 = cssVar('--text-3', 'rgba(16,35,56,.38)');
  const card = cssVar('--card', '#ffffff');
  const border = cssVar('--border', 'rgba(23,58,90,.15)');
  const green = cssVar('--green', '#34c759');
  const accent = cssVar('--accent', '#b4843a');

  const values = (opts.values || []).slice(0, n).map((x) => clamp01(Number(x) || 0));
  const lineValues = (opts.lineValues || []).slice(0, n).map((x) => clamp01(Number(x) || 0));
  const met = opts.met || [];

  // 尺寸：容器宽 100%、aspect-ratio 1/1（CSS 保证正方形）；DPR 适配高清屏
  const w = Math.max(1, canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 320);
  const h = Math.max(1, canvas.clientHeight || w);
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = card;
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 30; // 给模块名标签留出外部空间
  if (R <= 8) return;
  const step = (Math.PI * 2) / n;
  const angle = (i) => -Math.PI / 2 + i * step;
  const pt = (i, r) => [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))];

  // 同心多边形网格（25/50/75/100）
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.9;
  for (const f of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const [x, y] = pt(i, R * f);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  // 径向轴线（中心到顶点）；达标轴（met）用绿描边置亮
  ctx.globalAlpha = 1;
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i, R);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.strokeStyle = met[i] ? green : border;
    ctx.lineWidth = met[i] ? 1.4 : 1;
    ctx.globalAlpha = met[i] ? 0.9 : 0.7;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;

  // 刻度标签：0 / 50 / 100 沿顶部轴（i=0）标注
  ctx.fillStyle = text3;
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const scaleX = cx + 6;
  ctx.fillText('0', scaleX, cy);
  const [, y50] = pt(0, R * 0.5);
  const [, y100] = pt(0, R * 1);
  ctx.fillText('50', scaleX, y50);
  ctx.fillText('100', scaleX, y100);

  // 虚线多边形 = 达标线
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i, lineValues[i] * R);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.setLineDash([]);

  // 实线多边形 = 我的正确率（半透明填充 + 描边）
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i, values[i] * R);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = primary;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = primary;
  ctx.lineWidth = 2;
  ctx.stroke();

  // 顶点：达标轴绿色圆点置亮，其余灰点
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i, values[i] * R);
    ctx.beginPath();
    ctx.arc(x, y, met[i] ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = met[i] ? green : text3;
    ctx.globalAlpha = met[i] ? 1 : 0.75;
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 模块名标签（>4 字换行，两行居中）
  ctx.fillStyle = text2;
  ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i, R + 14);
    const lines = wrapLabel(labels[i] || '');
    if (lines.length === 1) {
      ctx.fillText(lines[0], x, y);
    } else {
      ctx.fillText(lines[0], x, y - 6);
      ctx.fillText(lines[1], x, y + 6);
    }
  }
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/** 模块名换行：≤4 字单行，>4 字拆成两行（如「言语理解与表达」→「言语理解」「与表达」） */
function wrapLabel(label) {
  const s = String(label || '').trim();
  if (s.length <= 4) return [s];
  const half = Math.ceil(s.length / 2);
  return [s.slice(0, half), s.slice(half)];
}
