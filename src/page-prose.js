/**
 * 固定ページ（.astro）の本文 <div class="prose"> の読み書き。
 * 入れ子の <div> があっても、対応する閉じタグまでを本文として扱う。
 */

// コメント・script・style の中の <div> は数えないため、まとめて読み飛ばす
const TOKEN =
  /<!--[\s\S]*?-->|<(script|style)\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/\1\s*>|<div\b(?:"[^"]*"|'[^']*'|\{[^{}]*\}|[^'"{}>])*>|<\/div\s*>/gi;

function isProseOpen(tag) {
  const match = tag.match(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return Boolean(match) && (match[1] ?? match[2]).split(/\s+/).includes('prose');
}

/** 本文の開始位置と終了位置を返す。見つからない・閉じていない場合は null */
export function findProse(source) {
  let start = -1;
  let depth = 0;
  for (const match of String(source).matchAll(TOKEN)) {
    const token = match[0];
    if (token.startsWith('<!--') || match[1]) continue;
    const isClose = token.startsWith('</');
    const selfClosing = token.endsWith('/>');
    if (start < 0) {
      if (!isClose && !selfClosing && isProseOpen(token)) {
        start = match.index + token.length;
        depth = 1;
      }
      continue;
    }
    if (isClose) depth -= 1;
    else if (!selfClosing) depth += 1;
    if (depth === 0) return { start, end: match.index };
  }
  return null;
}

export function extractProse(source) {
  const range = findProse(source);
  return range ? source.slice(range.start, range.end).trim() : null;
}

/** 本文を差し替えた内容を返す。本文の場所が特定できない場合は null */
export function replaceProse(source, content) {
  const range = findProse(source);
  if (!range) return null;
  const body = String(content).trim();
  return `${source.slice(0, range.start)}\n${body}\n${source.slice(range.end)}`;
}
