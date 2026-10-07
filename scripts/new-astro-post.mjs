import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const root = process.cwd();

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function isBlank(value) {
  return value === undefined || String(value).trim() === '';
}

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function quote(value) {
  return JSON.stringify(value);
}

function formatArray(values) {
  return `[${values.map(quote).join(', ')}]`;
}

async function promptMissing(args, { interactive }) {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('Create a new Astro post.');
    console.log('Press Enter to keep optional fields empty.');
    console.log('');

    const slug = isBlank(args.slug)
      ? await rl.question('slug (lowercase letters, numbers, hyphens): ')
      : args.slug;
    const title = isBlank(args.title)
      ? await rl.question('title: ')
      : args.title;
    const description = isBlank(args.description)
      ? await rl.question('description: ')
      : args.description;
    const pubDate = isBlank(args.date)
      ? await rl.question('pubDate (YYYY-MM-DD or ISO): ')
      : args.date;
    const categories =
      args.category ??
      (interactive
        ? await rl.question('categories (comma separated, optional): ')
        : '');
    const tags =
      args.tag ??
      (interactive
        ? await rl.question('tags (comma separated, optional): ')
        : '');
    const thumbnailAnswer = args.thumbnail
      ? 'y'
      : interactive
        ? await rl.question('configure thumbnail import? (y/N): ')
        : 'n';
    const publishAnswer =
      args.publish || args.draft === 'false'
        ? 'y'
        : interactive
          ? await rl.question('publish now? (y/N): ')
          : 'n';

    return {
      ...args,
      slug,
      title,
      description,
      date: pubDate,
      category: categories,
      tag: tags,
      thumbnail: /^y(es)?$/i.test(String(thumbnailAnswer).trim()),
      publish: /^y(es)?$/i.test(String(publishAnswer).trim()),
    };
  } finally {
    rl.close();
  }
}

async function assertNotExists(filePath) {
  try {
    await fs.access(filePath);
    throw new Error(`Already exists: ${path.relative(root, filePath)}`);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

function makeMetaEntry({
  slug,
  title,
  description,
  date,
  category,
  tag,
  draft,
}) {
  const draftLine = draft ? '\n\t\tdraft: true,' : '';
  return `\t{
\t\tslug: ${quote(slug)},
\t\ttitle: ${quote(title)},
\t\tdescription: ${quote(description)},
\t\tpubDate: new Date(${quote(date)}),
\t\ttags: ${formatArray(splitList(tag))},
\t\tcategories: ${formatArray(splitList(category))},${draftLine}
\t\theadings: [
\t\t\t{ depth: 2, slug: 'intro', text: '本文' },
\t\t],
\t}`;
}

function makeArticle({ slug, title }) {
  return `<h2 id="intro">本文</h2>

<p>${title} の本文を書き始めます。</p>

<!-- 画像は public/images/posts/${slug}/ に置き、post-image スニペットで挿入します。 -->
`;
}

function makePage(slug) {
  return `---
import ArticleBody from '../../articles/${slug}.astro';
import { getAstroPost } from '../../content/astro-posts';
import BlogPost from '../../layouts/BlogPost.astro';

const post = getAstroPost('${slug}');

if (!post) {
\tthrow new Error('Astro post metadata not found: ${slug}');
}
---

<BlogPost
\ttitle={post.title}
\tdescription={post.description}
\tpubDate={post.pubDate}
\tupdatedDate={post.updatedDate}
\theadings={post.headings}
>
\t<ArticleBody />
</BlogPost>
`;
}

function makePageWithThumbnail(slug) {
  return `---
import ArticleBody from '../../articles/${slug}.astro';
import thumbnail from '../../assets/post-thumbnails/${slug}.webp';
import { getAstroPost } from '../../content/astro-posts';
import BlogPost from '../../layouts/BlogPost.astro';

const post = getAstroPost('${slug}');

if (!post) {
\tthrow new Error('Astro post metadata not found: ${slug}');
}
---

<BlogPost
\ttitle={post.title}
\tdescription={post.description}
\tpubDate={post.pubDate}
\tupdatedDate={post.updatedDate}
\theroImage={thumbnail}
\theadings={post.headings}
>
\t<ArticleBody />
</BlogPost>
`;
}

async function main() {
  const initialArgs = parseArgs(process.argv.slice(2));
  const args = await promptMissing(initialArgs, {
    interactive:
      Boolean(initialArgs.interactive) || Object.keys(initialArgs).length === 0,
  });
  const slug = String(args.slug).trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(
      'slug must use lowercase letters, numbers, and hyphens only.'
    );
  }

  const title = String(args.title).trim();
  const description = String(args.description).trim();
  const date = String(args.date).trim();
  if (!title || !description || !date) {
    throw new Error('title, description, and date are required.');
  }

  const draft = args.publish ? false : args.draft === 'false' ? false : true;
  const articlePath = path.join(root, 'src', 'articles', `${slug}.astro`);
  const pagePath = path.join(root, 'src', 'pages', 'posts', `${slug}.astro`);
  const imageDir = path.join(root, 'public', 'images', 'posts', slug);
  const thumbnailDir = path.join(root, 'src', 'assets', 'post-thumbnails');
  const metaPath = path.join(root, 'src', 'content', 'astro-posts.ts');

  await assertNotExists(articlePath);
  await assertNotExists(pagePath);

  const meta = await fs.readFile(metaPath, 'utf8');
  if (new RegExp(`slug:\\s*['"]${slug}['"]`).test(meta)) {
    throw new Error(`Metadata already exists for slug: ${slug}`);
  }

  const entry = makeMetaEntry({
    ...args,
    slug,
    title,
    description,
    date,
    draft,
  });
  const updatedMeta = meta.replace(
    /\r?\n\];\r?\n\r?\nexport function getAstroPost/,
    (match) => {
      const lineBreak = match.includes('\r\n') ? '\r\n' : '\n';
      return `,${lineBreak}${entry}${lineBreak}];${lineBreak}${lineBreak}export function getAstroPost`;
    }
  );
  if (updatedMeta === meta) {
    throw new Error(
      'Could not insert metadata into src/content/astro-posts.ts.'
    );
  }

  if (args['dry-run']) {
    console.log(`Dry run OK: ${slug}`);
    console.log(`- src/articles/${slug}.astro`);
    console.log(`- src/pages/posts/${slug}.astro`);
    console.log(`- public/images/posts/${slug}/`);
    console.log('- src/assets/post-thumbnails/');
    console.log('- src/content/astro-posts.ts');
    return;
  }

  await fs.mkdir(imageDir, { recursive: true });
  await fs.mkdir(thumbnailDir, { recursive: true });
  await fs.writeFile(articlePath, makeArticle({ slug, title }));
  await fs.writeFile(
    pagePath,
    args.thumbnail ? makePageWithThumbnail(slug) : makePage(slug)
  );
  await fs.writeFile(metaPath, updatedMeta);

  console.log(`Created Astro post: ${slug}`);
  console.log(`- src/articles/${slug}.astro`);
  console.log(`- src/pages/posts/${slug}.astro`);
  console.log(`- public/images/posts/${slug}/`);
  console.log('- src/assets/post-thumbnails/');
  console.log('- src/content/astro-posts.ts');
  console.log(draft ? 'Status: draft' : 'Status: published');
  if (!args.thumbnail) {
    console.log(
      'Thumbnail: not configured. Add --thumbnail to generate a heroImage import.'
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
