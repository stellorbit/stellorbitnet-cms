import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

function parseSlugs(argv) {
  const slugIndex = argv.indexOf('--slug');
  if (slugIndex >= 0 && argv[slugIndex + 1]) {
    return new Set([argv[slugIndex + 1]]);
  }
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x26;/g, '&');
}

function extractHeadings(article) {
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

function formatHeadings(headings, indent = '      ') {
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

function findEntryRange(source, slug) {
  const slugMatch = new RegExp(
    String.raw`\{\s*[\r\n]+[\s]*slug:\s*['"]${escapeRegExp(slug)}['"]`
  ).exec(source);

  if (!slugMatch) return null;

  const start = slugMatch.index;
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        let end = i + 1;
        while (/\s/.test(source[end] ?? '')) end += 1;
        if (source[end] === ',') end += 1;
        return { start, end };
      }
    }
  }

  return null;
}

function replaceHeadings(entry, headings) {
  const slugLineMatch = entry.match(/^[ \t]*slug:/m);
  const baseIndent = slugLineMatch
    ? slugLineMatch[0].match(/^[ \t]*/)[0]
    : '      ';
  const replacement = formatHeadings(headings, baseIndent);

  const headingsBlock = /^[ \t]*headings:\s*\[[\s\S]*?^[ \t]*\],?/m;
  if (headingsBlock.test(entry)) {
    return entry.replace(headingsBlock, replacement);
  }

  const closingBraceIndex = entry.lastIndexOf('}');
  if (closingBraceIndex < 0) {
    throw new Error('Could not find entry end.');
  }

  return `${entry.slice(0, closingBraceIndex)}  ${replacement}\n${entry.slice(closingBraceIndex)}`;
}

async function getArticleSlugs() {
  const articlesDir = path.join(root, 'src', 'articles');
  const entries = await fs.readdir(articlesDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.astro'))
    .map((entry) => entry.name.replace(/\.astro$/, ''));
}

async function main() {
  const selectedSlugs = parseSlugs(process.argv.slice(2));
  const metaPath = path.join(root, 'src', 'content', 'astro-posts.ts');
  let meta = await fs.readFile(metaPath, 'utf8');

  const articleSlugs = await getArticleSlugs();
  const targetSlugs = selectedSlugs ? [...selectedSlugs] : articleSlugs;

  for (const slug of targetSlugs) {
    if (slug.length > 120) {
      throw new Error(`Suspiciously long slug detected: ${slug}`);
    }

    const articlePath = path.join(root, 'src', 'articles', `${slug}.astro`);

    try {
      const article = await fs.readFile(articlePath, 'utf8');
      const headings = extractHeadings(article);
      const range = findEntryRange(meta, slug);

      if (!range) {
        throw new Error(`Metadata not found: ${slug}`);
      }

      const entry = meta.slice(range.start, range.end);
      const updatedEntry = replaceHeadings(entry, headings);
      meta = `${meta.slice(0, range.start)}${updatedEntry}${meta.slice(range.end)}`;

      console.log(`Synced ${slug}: ${headings.length} headings`);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }

  await fs.writeFile(metaPath, meta);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
