// radar-chart.js — 零依赖 canvas 雷达图（AI 能力诊断）
// drawRadar(canvas, { labels, values, lineValues, met, insuff, animate })
//   labels:      轴名数组（6 个模块名；>4 字自动换行）
//   values:      实际正确率 0–1（正六角边形，进入时自中心展开动画）
//   lineValues:  达标线 0–1（金色圆点虚线的达标六角形）
//   met:         达标轴 boolean[]（true 的轴顶点数值胶囊以绿色置亮）
//   insuff:      数据不足轴 boolean[]（total<5：不画假 0% 胶囊，画空心灰点）
//   animate:     是否播放展开动画（首绘 true；resize 重绘传 false 避免重播）
// 覆盖面积填充：达标线内面积用 --accent 低透明填充，能力边界用 --primary 低透明填充——
//   「达标内、能力外」的环带即差距区。两块同向自中心展开（动画 t 双多边形同步缩放）。
// 颜色随主题：getComputedStyle(canvas) 读 CSS 变量（--primary/--primary-soft/--green/--green-soft/--accent/--text-2/--text-3/--border）
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
  const primarySoft = cssVar('--primary-soft', 'rgba(20, 80, 141, .10)');
  const green = cssVar('--green', '#34c759');
  const greenSoft = cssVar('--green-soft', 'rgba(52, 199, 89, .12)');
  const accent = cssVar('--accent', '#b4843a');
  const text2 = cssVar('--text-2', 'rgba(16, 35, 56, .62)');
  const text3 = cssVar('--text-3', 'rgba(16, 35, 56, .38)');
  const border = cssVar('--border', 'rgba(23, 58, 90, .15)');

  const values = (opts.values || []).slice(0, n).map((x) => clamp01(Number(x) || 0));
  const lineValues = (opts.lineValues || []).slice(0, n).map((x) => clamp01(Number(x) || 0));
  const met = opts.met || [];
  const insuff = opts.insuff || [];
  const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

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
  ctx.clearRect(0, 0, w, h); // 透明底：让卡片自身背景/圆角透出

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 32; // 给模块名标签留出外部空间
  if (R <= 8) return;
  const step = (Math.PI * 2) / n;
  const angle = (i) => -Math.PI / 2 + i * step;
  const pt = (i, r) => [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))];

  /** 正六角形顶点数组（半径 r） */
  function hexPts(r) {
    return Array.from({ length: n }, (_, i) => pt(i, r));
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  /** 六角形同心网格（25/50/75/100）+ 径向轴线 */
  function drawGrid() {
    for (const f of [0.25, 0.5, 0.75, 1]) {
      hexPathPts(hexPts(R * f));
      ctx.strokeStyle = border;
      ctx.globalAlpha = f === 1 ? 0.8 : 0.45;
      ctx.lineWidth = f === 1 ? 1.2 : 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // 径向轴线：数据轴（met）用绿置亮，其余细灰
    for (let i = 0; i < n; i++) {
      const [x, y] = pt(i, R);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.strokeStyle = met[i] ? green : border;
      ctx.globalAlpha = met[i] ? 0.85 : 0.5;
      ctx.lineWidth = met[i] ? 1.4 : 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * 覆盖面积填充（随动画 t 同步缩放，t=1 即最终形态）：
   *   1) 达标线内面积 — accent 低透明（先画，作为底层）
   *   2) 能力边界 — primary 低透明（后画，叠加在达标面积之上）
   *   叠加结果：「达标外、能力内」区域是纯主色，「达标内、能力外」是金色环带（差距区）
   */
  function drawAreaFill(t) {
    if (t <= 0.02) return;
    // 达标线内面积（金色底层）
    hexPathPts(lineValues.map((v, i) => pt(i, v * t * R)));
    ctx.globalAlpha = 0.07 * t;
    ctx.fillStyle = accent;
    ctx.fill();
    // 能力边界（主色叠加层）
    hexPathPts(values.map((v, i) => pt(i, v * t * R)));
    ctx.globalAlpha = 0.16 * t;
    ctx.fillStyle = primary;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** 闭合直边路径（给定顶点数组，尖角六角形） */
  function hexPathPts(pts) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  }

  /** 达标线：金色圆点虚线六角形 */
  function drawTarget() {
    ctx.beginPath();
    lineValues.map((v, i) => pt(i, v * R)).forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.setLineDash([0.1, 6]);
    ctx.lineCap = 'round';
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /** 数据多边形描边 + 顶点数值胶囊/数据不足空心点（填充由 drawAreaFill 负责，避免重复叠色） */
  function drawData(t) {
    const pts = values.map((v, i) => pt(i, v * t * R));
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.strokeStyle = primary;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    for (let i = 0; i < n; i++) {
      const [x, y] = pts[i];
      if (insuff[i]) {
        // 数据不足：空心灰点，不画假 0% 胶囊
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = text3;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        continue;
      }
      const pillAlpha = clamp01((t - 0.45) / 0.4); // 胶囊随动画后段淡入
      if (pillAlpha > 0.02) {
        ctx.font = `700 10px ${FONT}`;
        const label = `${Math.round(values[i] * 100)}%`;
        const pw = ctx.measureText(label).width + 12;
        const ph = 16;
        ctx.globalAlpha = pillAlpha;
        roundRect(x - pw / 2, y - ph / 2, pw, ph, ph / 2);
        ctx.fillStyle = met[i] ? greenSoft : primarySoft;
        ctx.fill();
        ctx.globalAlpha = pillAlpha;
        ctx.fillStyle = met[i] ? green : primary;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x, y + 0.5);
        ctx.globalAlpha = 1;
      }
    }
  }

  /** 模块名标签（>4 字换行，两行居中） */
  function drawLabels() {
    ctx.fillStyle = text2;
    ctx.font = `600 11px ${FONT}`;
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

  function drawFrame(t) {
    drawGrid();
    drawAreaFill(t);
    drawTarget();
    drawData(t);
    drawLabels();
  }

  // 取消上一轮动画（resize 期间 drawRadar 被再次调用时防止叠加）
  if (canvas.__abRaf) { cancelAnimationFrame(canvas.__abRaf); canvas.__abRaf = null; }

  const reduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!opts.animate || reduced) { drawFrame(1); return; }

  // 展开动画：ease-out，~600ms
  const DUR = 600;
  const t0 = performance.now();
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);
  const tick = (now) => {
    const p = easeOut(clamp01((now - t0) / DUR));
    drawFrame(p);
    if (p < 1) canvas.__abRaf = requestAnimationFrame(tick);
    else canvas.__abRaf = null;
  };
  canvas.__abRaf = requestAnimationFrame(tick);
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