// markdown.js — 零依赖迷你 markdown 渲染器（AI 长文本展示用）
// renderMarkdown(src) → HTML string。
// 安全：所有进入 DOM 的文本一律先 HTML 转义再白名单解析 → 任何原始标签/脚本原样显示，无法注入。
// 块级解析在原始行上进行（# 标题、- 列表、> 引用、``` 代码等记号不被转义干扰），
// 内容文本在行内解析时统一 esc。
// 支持：`#/##/###` 标题、``` 代码块、`-`/`1.` 列表（含两空格缩进子列表）、`>` 引用、
//       `---` 分隔线、`**粗体**` `*斜体*`、`[文字](http链接)`、`行内码`、段落。
// 双端无需同步（仅前端 app.js 使用）。

export function renderMarkdown(src) {
  const text = String(src ?? '');
  if (!text.trim()) return '';

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^```/.test(line)) {
      const name = line.replace(/^```/, '').trim();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i++; }
      if (i < lines.length) i++;
      const klass = name ? ` class="lang-${name.replace(/[^\w-]/g, '')}"` : '';
      out.push(`<pre><code${klass}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    // 分隔线
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // 标题
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    // 引用：连续 > 行合并为一段
    if (/^>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
      continue;
    }

    // 列表
    const liMatch = /^ {0,2}([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (liMatch) {
      const block = consumeList(lines, i);
      out.push(renderList(block.items));
      i = block.next;
      continue;
    }

    // 空行
    if (/^\s*$/.test(line)) { i++; continue; }

    // 段落：合并直到空行或块级起点。注意括号内匹配的是「未转义」原始行，需先用正则探测块级起点
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
      para.push(lines[i]); i++;
    }
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }

  return out.join('\n');
}

/** 原始行是否为块级起点（段落应在此截断） */
function isBlockStart(line) {
  return /^(```|>|#{1,3}\s|-{3,}|\*\*\*+|___+)/.test(line)
    || /^ {0,2}([-*]|\d+\.)\s/.test(line);
}

const LIST_RE = /^ {0,2}([-*]|\d+\.)\s+(.*)$/;
const SUB_RE = /^ {2,}([-*]|\d+\.)\s+(.*)$/;

/** HTML 转义（& 必须最先，防二次转义） */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内解析（输入为原始文本，先 esc 再变换）：先占位行内码（防 tick 内 `**` 等被误改），再粗体/斜体/链接，最后回填 */
function inline(s) {
  const e0 = esc(s);
  const codeSpans = [];
  const tmp = e0.replace(/`([^`\n]+)`/g, (_m, c) => {
    codeSpans.push(`<code>${c}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  return tmp
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s<]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\u0000(\d+)\u0000/g, (_m, n) => codeSpans[Number(n)] || '');
}

/** 收集一个列表块：顶层 depth 0；两空格缩进为子项 depth 1。顶层项跨空行仍并入同一列表（松散列表）。 */
function consumeList(lines, i) {
  const items = [];
  function push(raw, isSub) {
    const m = (isSub ? SUB_RE : LIST_RE).exec(raw);
    if (m) items.push({ depth: isSub ? 1 : 0, ordered: /^\d/.test(m[1]), text: m[2] });
  }
  push(lines[i], false);
  i++;
  while (i < lines.length) {
    const l = lines[i];
    if (SUB_RE.test(l)) { push(l, true); i++; continue; }
    if (LIST_RE.test(l)) { push(l, false); i++; continue; }
    if (/^\s*$/.test(l)) {
      // 空行后仍为顶层列表项 → 属于同一松散列表；否则列表结束
      let j = i;
      while (j < lines.length && /^\s*$/.test(lines[j])) j++;
      if (j < lines.length && LIST_RE.test(lines[j])) {
        i = j;
        push(lines[i], false); i++;
        continue;
      }
      break;
    }
    break;
  }
  return { items, next: i };
}

/** 按缩进树渲染嵌套 <ul>/<ol>；同层连续同类项共用一个列表容器，数字由浏览器自动编号。 */
function renderList(items) {
  // 构建嵌套树：栈保存父级节点
  const root = { children: [] };
  const stack = [{ depth: -1, children: root.children }];
  for (const it of items) {
    while (stack.length > 1 && stack[stack.length - 1].depth >= it.depth) stack.pop();
    const parent = stack[stack.length - 1];
    const node = { depth: it.depth, ordered: it.ordered, text: it.text, children: [] };
    parent.children.push(node);
    stack.push(node);
  }
  return renderChildren(root.children);

  function renderChildren(children) {
    let html = '';
    for (let i = 0; i < children.length;) {
      const ordered = children[i].ordered;
      html += ordered ? '<ol>' : '<ul>';
      while (i < children.length && children[i].ordered === ordered) {
        const node = children[i];
        html += `<li>${inline(node.text)}${node.children.length ? renderChildren(node.children) : ''}</li>`;
        i++;
      }
      html += ordered ? '</ol>' : '</ul>';
    }
    return html;
  }
}