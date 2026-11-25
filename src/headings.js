/**
 * 記事本文の見出し処理。
 * extractHeadings / formatHeadings / replaceHeadings の出力は、サイト側の
 * ビルド前同期（scripts/sync-astro-post-headings.mjs）と一致させること。
 */

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x26;/g, '&');
}

// 見出し ID 用の平文。タグを除き、空白系と数値の文字参照を実際の文字に戻す
function headingPlainText(inner) {
  const withoutTags = inner.replace(/<[^>]+>/g, '');
  const decoded = withoutTags
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(x[0-9a-fA-F]+|\d+);/g, (match, code) => {
      const point = code.startsWith('x') ? parseInt(code.slice(1), 16) : Number(code);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    });
  return decodeEntities(decoded).trim();
}

// 画面の「ID一括付与」（autoGenerateHeadingIds）と同じ規則
function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9぀-ゟ゠-ヿ一-龯_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * id のない h2・h3 に、見出し文から作った id を付与する。
 * 既存の id、HTML コメント内、文字のない見出しは変更しない。
 */
export function assignHeadingIds(article) {
  const usedIds = new Set(
    [...article.matchAll(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(
      (match) => match[1] ?? match[2]
    )
  );
  // 同じ見出しが多くても連番を先頭から探し直さない
  const nextSuffix = new Map();
  let position = 0;

  return article.replace(
    /<!--[\s\S]*?-->|<h([23])(?=[\s/>])([^>]*)>([\s\S]*?)<\/h\1>/g,
    (match, depth, attrs, inner) => {
      if (!depth) return match;
      position += 1;

      const cleanedAttrs = attrs.replace(/\s+id\s*=\s*(?:"\s*"|'\s*')/g, '');
      if (/(?:^|\s)id\s*=/.test(cleanedAttrs)) return match;

      const text = headingPlainText(inner);
      if (!text) return match;

      const base = slugifyHeading(text) || `heading-${position}`;
      let suffix = nextSuffix.get(base) ?? 2;
      let id = base;
      while (usedIds.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
      nextSuffix.set(base, suffix);
      usedIds.add(id);

      return `<h${depth} id="${id}"${cleanedAttrs}>${inner}</h${depth}>`;
    }
  );
}

export function extractHeadings(article) {
  return [...article.matchAll(/<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/g)].flatMap(
    (match) => {
      const depth = Number(match[1]);
      const attrs = match[2];
      const inner = match[3];
      const idMatch = attrs.match(/\bid="([^"]+)"/);
      if (!idMatch) return [];

      return [
        {
          depth,
          slug: idMatch[1],
          text: decodeEntities(
            inner
              .replace(/<[^>]+>/g, '')
              .replace(/\s+/g, ' ')
              .trim()
          ),
        },
      ];
    }
  );
}

export function formatHeadings(headings, indent = '      ') {
  if (headings.length === 0) {
    return `${indent}headings: [],`;
  }

  const itemIndent = `${indent}  `;
  return `${indent}headings: [
${headings
  .map(
    (heading) =>
      `${itemIndent}{ depth: ${heading.depth}, slug: ${JSON.stringify(heading.slug)}, text: ${JSON.stringify(heading.text)} }`
  )
  .join(',\n')}
${indent}],`;
}

export function replaceHeadings(entry, headings) {
  const slugLineMatch = entry.match(/^[ \t]*slug:/m);
  const baseIndent = slugLineMatch
    ? slugLineMatch[0].match(/^[ \t]*/)[0]
    : '      ';
  const replacement = formatHeadings(headings, baseIndent);

  const headingsBlock = /^[ \t]*headings:\s*\[(?:\],?|[\s\S]*?^[ \t]*\],?)/m;
  if (headingsBlock.test(entry)) {
    // 関数指定にして、見出し文内の $ が置換パターンとして解釈されるのを防ぐ
    return entry.replace(headingsBlock, () => replacement);
  }

  const closingBraceIndex = entry.lastIndexOf('}');
  if (closingBraceIndex < 0) {
    throw new Error('Could not find entry end.');
  }

  return `${entry.slice(0, closingBraceIndex)}  ${replacement}\n${entry.slice(closingBraceIndex)}`;
}
