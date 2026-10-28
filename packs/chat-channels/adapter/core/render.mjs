// Outbox text → platform message (channel-adapter.v1 §4.8). Input is the CommonMark
// subset the Soot writes; everything else is escaped. Messages are never split: an
// over-long one is cut at a paragraph or sentence and ends with copy.truncated.

export const LIMITS = {telegram: 4096, discord: 2000};

const escHTML = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = text => escHTML(text).replace(/"/g, '&quot;');

export const FORMATS = {
  telegram: {
    text: escHTML,
    bold: inner => `<b>${inner}</b>`,
    italic: inner => `<i>${inner}</i>`,
    code: text => `<code>${escHTML(text)}</code>`,
    pre: text => `<pre>${escHTML(text)}</pre>`,
    link: (label, url) => `<a href="${escAttr(url)}">${escHTML(label)}</a>`,
  },
  discord: {
    // Backslash-escape markdown and mention syntax; line-start markers are handled per line.
    text: text => text.replace(/[\\*_~`|<>[\]]/g, '\\$&'),
    bold: inner => `**${inner}**`,
    italic: inner => `_${inner}_`,
    code: text => `\`${text.replace(/`/g, 'ˋ')}\``,
    pre: text => '```\n' + text.replace(/```/g, 'ˋˋˋ') + '\n```',
    link: (label, url) => `[${label.replace(/[\\[\]]/g, '\\$&')}](<${url.replace(/[<>\s]/g, encodeURIComponent)}>)`,
  },
};

// Paragraph / fenced-code blocks.
export function parseBlocks(markdown) {
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) blocks.push({type: 'para', lines: para}); para = []; };
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      flush();
      const body = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      blocks.push({type: 'code', lines: body});
    } else if (!lines[i].trim()) flush();
    else para.push(lines[i]);
  }
  flush();
  return blocks;
}

const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|(?<![\p{L}\p{N}_])_(?!\s)(.+?)(?<!\s)_(?![\p{L}\p{N}_])|(?<![*\p{L}\p{N}])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\p{L}\p{N}])/gu;
const RAW_NEST = /nest:\/\/[^\s)\]]+/g;

export function renderInline(text, fmt, links = []) {
  let out = '', last = 0;
  for (const match of text.matchAll(INLINE)) {
    out += plain(text.slice(last, match.index), fmt, links);
    last = match.index + match[0].length;
    const [, code, label, href, bold, under, star] = match;
    if (code !== undefined) out += fmt.code(code);
    else if (label !== undefined) out += link(label, href, fmt, links);
    else if (bold !== undefined) out += fmt.bold(renderInline(bold, fmt, links));
    else out += fmt.italic(renderInline(under ?? star, fmt, links));
  }
  return out + plain(text.slice(last), fmt, links);
}

// A raw nest:// never reaches the person: its label if the host gave one, else nothing.
function plain(text, fmt, links) {
  return fmt.text(text.replace(RAW_NEST, href => links.find(entry => entry.href === href)?.label ?? ''));
}

function link(label, href, fmt, links) {
  if (href.startsWith('nest://')) {
    const entry = links.find(item => item.href === href);
    if (!entry) return fmt.text(label);
    return entry.url ? fmt.link(entry.label, entry.url) : fmt.text(entry.label);
  }
  return /^https?:\/\//i.test(href) ? fmt.link(label, href) : fmt.text(label);
}

function renderLine(line, fmt, links) {
  const bullet = line.match(/^\s*[-*]\s+(.*)$/);
  if (bullet) return '• ' + renderInline(bullet[1], fmt, links);
  const rendered = renderInline(line, fmt, links);
  // Discord treats these at line start as heading/quote/list markers.
  return fmt === FORMATS.discord ? rendered.replace(/^(\s*)([#>-])/, '$1\\$2') : rendered;
}

export function renderBlocks(blocks, fmt, links) {
  return blocks.map(block => block.type === 'code'
    ? fmt.pre(block.lines.join('\n'))
    : block.lines.map(line => renderLine(line, fmt, links)).join('\n')).join('\n\n');
}

const sentences = line => line.match(/[^.!?…]+(?:[.!?…]+|$)\s*/g) ?? [line];

// Largest prefix of `block` (by sentence, or by line for code) whose render fits.
function partial(block, fits) {
  if (block.type === 'code') {
    const lines = [];
    for (const line of block.lines) {
      if (!fits({type: 'code', lines: [...lines, line]})) break;
      lines.push(line);
    }
    return lines.length ? {type: 'code', lines} : null;
  }
  const lines = [];
  for (const line of block.lines) {
    if (fits({type: 'para', lines: [...lines, line]})) { lines.push(line); continue; }
    let cut = '';
    for (const sentence of sentences(line)) {
      if (!fits({type: 'para', lines: [...lines, (cut + sentence).trimEnd()]})) break;
      cut += sentence;
    }
    if (cut.trim()) lines.push(cut.trimEnd());
    break;
  }
  return lines.length ? {type: 'para', lines} : null;
}

// Hard cut at a word boundary when not even one sentence fits.
function hardCut(block, fits) {
  const text = block.type === 'code' ? block.lines.join('\n') : block.lines.join(' ');
  const words = text.split(/(\s+)/);
  let kept = '';
  for (const word of words) {
    const next = kept + word;
    if (!fits({type: block.type, lines: [next.trimEnd()]})) break;
    kept = next;
  }
  if (kept.trim()) return {type: block.type, lines: [kept.trimEnd()]};
  // A single giant word: cut characters.
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits({type: block.type, lines: [text.slice(0, mid)]})) low = mid; else high = mid - 1;
  }
  return low ? {type: block.type, lines: [text.slice(0, low)]} : null;
}

// Renders an outbox item for `platform`. Returns {text, buttons} where buttons are
// [{label, style?, token}|{label, style?, url}] in display order.
export function renderItem(item, {platform, copy = {}}) {
  const fmt = FORMATS[platform];
  const limit = LIMITS[platform];
  const links = Array.isArray(item.links) ? item.links : [];
  const blocks = parseBlocks(item.text);
  const attention = item.kind === 'attention' ? item.attention ?? {} : null;
  if (attention?.diff) blocks.push({type: 'code', lines: String(attention.diff).split('\n')});
  const buttons = [], lines = [];
  for (const choice of attention?.choices ?? []) {
    if (!choice?.label) continue;
    if (choice.token) buttons.push({label: choice.label, style: choice.style, token: choice.token});
    else if (choice.url) buttons.push({label: choice.label, style: choice.style, url: choice.url});
    else lines.push(fmt.text(choice.label));
  }
  const tail = lines.length ? '\n\n' + lines.join('\n') : '';
  const full = renderBlocks(blocks, fmt, links);
  if (full.length + tail.length <= limit) return {text: full + tail, buttons};

  const more = item.open_url ? fmt.link(copy.open_in_nest || 'Nest', item.open_url) : fmt.text(copy.open_in_nest || '');
  const suffix = '\n\n' + fmt.text(copy.truncated || '…') + (more ? '\n' + more : '');
  const budget = limit - suffix.length - tail.length;
  const kept = [];
  const fits = block => renderBlocks([...kept, block], fmt, links).length <= budget;
  for (const block of blocks) {
    if (fits(block)) { kept.push(block); continue; }
    const cut = partial(block, fits) ?? (kept.length ? null : hardCut(block, fits));
    if (cut) kept.push(cut);
    break;
  }
  return {text: renderBlocks(kept, fmt, links) + suffix + tail, buttons};
}

// Host sentences (reply, notice, toast, copy.*) are plain text.
export const plainText = (text, platform) => FORMATS[platform].text(String(text ?? ''));
