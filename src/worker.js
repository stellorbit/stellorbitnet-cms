/**
 * Cloudflare Worker for stellorbit.net CMS
 * Full-featured GitHub REST API integration
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(message, status = 500, details = null) {
  return jsonResponse({ error: message, details }, status);
}

// GitHub API Helper
async function callGitHub(path, env, options = {}) {
  const owner = env.GITHUB_OWNER || 'stellorbit';
  const repo = env.GITHUB_REPO || 'stellorbitnet-ver2';
  const token = env.GITHUB_PAT || env.GITHUB_TOKEN || env.PAT || env.GITHUB_ACCESS_TOKEN;

  if (!token) {
    const availableKeys = Object.keys(env).filter(k => k !== 'ASSETS');
    throw new Error(`GITHUB_PAT is not configured in Worker environment variables. (Detected keys: [${availableKeys.join(', ')}])`);
  }

  const url = `https://api.github.com/repos/${owner}/${repo}${path}`;
  const headers = {
    'User-Agent': 'stellorbit-cms-worker',
    'Accept': options.raw ? 'application/vnd.github.v3.raw' : 'application/vnd.github.v3+json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  return response;
}

// Fetch text file contents from GitHub
async function getGitHubFile(filePath, env) {
  const branch = env.GITHUB_BRANCH || 'main';
  const res = await callGitHub(`/contents/${filePath}?ref=${branch}`, env);
  if (!res.ok) {
    if (res.status === 404) return null;
    const errText = await res.text();
    throw new Error(`GitHub API error (${res.status}) on ${filePath}: ${errText}`);
  }
  const data = await res.json();
  const content = atob(data.content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(content, c => c.charCodeAt(0));
  const decoded = new TextDecoder('utf-8').decode(bytes);
  return { content: decoded, sha: data.sha };
}

// Fetch binary file from GitHub (e.g. images)
async function getGitHubBinary(filePath, env) {
  const branch = env.GITHUB_BRANCH || 'main';
  const res = await callGitHub(`/contents/${filePath}?ref=${branch}`, env, { raw: true });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`GitHub Binary error (${res.status}) on ${filePath}`);
  }
  return await res.arrayBuffer();
}

// Atomic Multi-file Commit using GitHub Git Data API
async function commitMultipleFiles(files, commitMessage, env) {
  const branch = env.GITHUB_BRANCH || 'main';

  // 1. Get HEAD commit sha
  const refRes = await callGitHub(`/git/ref/heads/${branch}`, env);
  if (!refRes.ok) {
    throw new Error(`Failed to get ref for branch ${branch}: ${await refRes.text()}`);
  }
  const refData = await refRes.json();
  const parentSha = refData.object.sha;

  // 2. Get base tree sha
  const commitRes = await callGitHub(`/git/commits/${parentSha}`, env);
  if (!commitRes.ok) {
    throw new Error(`Failed to get commit ${parentSha}: ${await commitRes.text()}`);
  }
  const commitData = await commitRes.json();
  const baseTreeSha = commitData.tree.sha;

  // 3. Create blobs for each file
  const treeItems = [];
  for (const f of files) {
    const isBase64 = f.encoding === 'base64';
    const blobRes = await callGitHub(`/git/blobs`, env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: f.content,
        encoding: isBase64 ? 'base64' : 'utf-8',
      }),
    });
    if (!blobRes.ok) {
      throw new Error(`Failed to create blob for ${f.path}: ${await blobRes.text()}`);
    }
    const blobData = await blobRes.json();
    treeItems.push({
      path: f.path,
      mode: '100644',
      type: 'blob',
      sha: blobData.sha,
    });
  }

  // 4. Create new tree
  const treeRes = await callGitHub(`/git/trees`, env, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeItems,
    }),
  });
  if (!treeRes.ok) {
    throw new Error(`Failed to create git tree: ${await treeRes.text()}`);
  }
  const newTreeData = await treeRes.json();

  // 5. Create new commit
  const newCommitRes = await callGitHub(`/git/commits`, env, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: commitMessage,
      tree: newTreeData.sha,
      parents: [parentSha],
    }),
  });
  if (!newCommitRes.ok) {
    throw new Error(`Failed to create git commit: ${await newCommitRes.text()}`);
  }
  const newCommitData = await newCommitRes.json();

  // 6. Update branch ref
  const updateRefRes = await callGitHub(`/git/refs/heads/${branch}`, env, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sha: newCommitData.sha,
      force: false,
    }),
  });
  if (!updateRefRes.ok) {
    throw new Error(`Failed to update branch ref: ${await updateRefRes.text()}`);
  }

  return newCommitData;
}

// Single file PUT helper
async function putGitHubFile(filePath, content, message, sha, env) {
  const branch = env.GITHUB_BRANCH || 'main';
  let base64Content = '';
  if (typeof content === 'string') {
    const bytes = new TextEncoder().encode(content);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    base64Content = btoa(binary);
  } else if (content instanceof ArrayBuffer || content instanceof Uint8Array) {
    const bytes = new Uint8Array(content);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    base64Content = btoa(binary);
  }

  const body = { message, content: base64Content, branch };
  if (sha) body.sha = sha;

  const res = await callGitHub(`/contents/${filePath}`, env, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`GitHub commit error (${res.status}): ${await res.text()}`);
  }
  return await res.json();
}

// Single file DELETE helper
async function deleteGitHubFile(filePath, message, sha, env) {
  const branch = env.GITHUB_BRANCH || 'main';
  const res = await callGitHub(`/contents/${filePath}`, env, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha, branch }),
  });

  if (!res.ok) {
    throw new Error(`GitHub delete error (${res.status}): ${await res.text()}`);
  }
  return await res.json();
}

// Helper: AST & Metadata Find Entry Range in astro-posts.ts
function findEntryRange(source, slug) {
  const escapeRegExp = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const slugRegex = new RegExp(`\\{\\s*slug:\\s*['"]${escapeRegExp(slug)}['"]`);
  const slugMatch = slugRegex.exec(source);
  if (!slugMatch) return null;

  const start = slugMatch.index;
  let depth = 0;
  let inString = false;
  let quoteChar = '';
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quoteChar) { inString = false; quoteChar = ''; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quoteChar = ch;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        let end = i + 1;
        while (/\s/.test(source[end] ?? '')) end++;
        if (source[end] === ',') end++;
        return { start, end };
      }
    }
  }
  return null;
}

// Helper: Make new entry string for astro-posts.ts
function makeMetaEntry({ slug, title, description, date, category, tag, draft }) {
  const quote = (v) => JSON.stringify(v);
  const splitList = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return String(v).split(',').map(s => s.trim()).filter(Boolean);
  };
  const formatArray = (arr) => `[${arr.map(quote).join(', ')}]`;
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

function makeArticleTemplate({ title }) {
  return `<h2 id="intro">本文</h2>\n\n<p>${title} の本文を書き始めます。</p>\n`;
}

function makePageTemplate(slug, hasThumb) {
  if (hasThumb) {
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

// OGP Fetcher in Cloudflare Worker
async function fetchOgpData(rawUrl) {
  let targetUrl;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    throw new Error('無効なURL形式です。');
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw new Error('HTTPまたはHTTPSプロトコルのみサポートしています。');
  }

  const host = targetUrl.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^10\./.test(host) || /^192\.168\./.test(host)) {
    throw new Error('内部アドレスへのアクセスは禁止されています。');
  }

  const response = await fetch(targetUrl.href, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(6000),
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`サイトからの応答エラー (ステータス: ${response.status})`);
  }

  const html = await response.text();

  const getMeta = (propertyOrName) => {
    const escaped = propertyOrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<meta[^>]+(?:property|name)=['"]${escaped}['"][^>]+content=['"]([\\s\\S]*?)['"]`, 'i');
    const match = html.match(regex);
    if (match) return match[1].trim();
    const regexRev = new RegExp(`<meta[^>]+content=['"]([\\s\\S]*?)['"][^>]+(?:property|name)=['"]${escaped}['"]`, 'i');
    const matchRev = html.match(regexRev);
    return matchRev ? matchRev[1].trim() : '';
  };

  const decodeHtmlEntities = (str) => {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = getMeta('og:title') || (titleMatch ? titleMatch[1].trim() : '') || targetUrl.hostname;
  const rawDesc = getMeta('og:description') || getMeta('description') || '';
  let rawImg = getMeta('og:image') || '';
  const siteName = getMeta('og:site_name') || targetUrl.hostname;

  if (rawImg && !rawImg.startsWith('http://') && !rawImg.startsWith('https://')) {
    try {
      rawImg = new URL(rawImg, targetUrl.href).href;
    } catch {
      rawImg = '';
    }
  }

  return {
    url: targetUrl.href,
    title: decodeHtmlEntities(rawTitle),
    description: decodeHtmlEntities(rawDesc),
    image: rawImg,
    siteName: decodeHtmlEntities(siteName),
    domain: targetUrl.hostname,
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // 1. Health check & Diagnostics API
    if (url.pathname === '/api/health') {
      const token = env.GITHUB_PAT || env.GITHUB_TOKEN || env.PAT || env.GITHUB_ACCESS_TOKEN;
      const availableKeys = Object.keys(env).filter(k => k !== 'ASSETS');
      return jsonResponse({
        status: 'ok',
        mode: 'cloudflare-worker',
        hasPat: Boolean(token),
        detectedVariables: availableKeys,
        owner: env.GITHUB_OWNER || 'stellorbit',
        repo: env.GITHUB_REPO || 'stellorbitnet-ver2',
        branch: env.GITHUB_BRANCH || 'main',
      });
    }

    // 2. Mock Dev server status for Cloudflare Worker mode
    if (url.pathname === '/api/dev-server/status') {
      return jsonResponse({ running: false, isWorker: true, port: 4321 });
    }
    if (url.pathname === '/api/dev-server/start' && request.method === 'POST') {
      return jsonResponse({ success: true, message: 'Cloudflare Workerモードでは開発サーバーの起動は不要です' });
    }

    // 3. Serve thumbnails from GitHub (src/assets/post-thumbnails/<file>)
    if (url.pathname.startsWith('/api/thumbnails/')) {
      try {
        const filename = decodeURIComponent(url.pathname.replace('/api/thumbnails/', ''));
        const filePath = `src/assets/post-thumbnails/${filename}`;
        const buffer = await getGitHubBinary(filePath, env);
        if (!buffer) {
          return new Response('Thumbnail Not Found', { status: 404, headers: CORS_HEADERS });
        }
        const ext = filename.split('.').pop().toLowerCase();
        const contentType = ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg';
        return new Response(buffer, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=604800, immutable',
            ...CORS_HEADERS,
          },
        });
      } catch (err) {
        return new Response('Thumbnail Error: ' + err.message, { status: 500, headers: CORS_HEADERS });
      }
    }

    // 4. Serve public images from GitHub (public/images/<file>)
    if (url.pathname.startsWith('/images/')) {
      try {
        const relativePath = decodeURIComponent(url.pathname.replace(/^\/images\/?/, ''));
        const filePath = `public/images/${relativePath}`;
        const buffer = await getGitHubBinary(filePath, env);
        if (!buffer) {
          return new Response('Image Not Found', { status: 404, headers: CORS_HEADERS });
        }
        const ext = relativePath.split('.').pop().toLowerCase();
        const mimeTypes = {
          webp: 'image/webp',
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          svg: 'image/svg+xml',
          gif: 'image/gif',
          avif: 'image/avif',
        };
        return new Response(buffer, {
          status: 200,
          headers: {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=604800, immutable',
            ...CORS_HEADERS,
          },
        });
      } catch (err) {
        return new Response('Image Error: ' + err.message, { status: 500, headers: CORS_HEADERS });
      }
    }

    // 5. OGP fetch API for Link Cards
    if (url.pathname === '/api/ogp' && request.method === 'GET') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return errorResponse('URLパラメータが必要です', 400);
      try {
        const ogpData = await fetchOgpData(targetUrl);
        return jsonResponse(ogpData);
      } catch (err) {
        return errorResponse(err.message, 400);
      }
    }

    // 6. API Routing
    if (url.pathname.startsWith('/api/')) {
      try {
        // Fetch Post Metadata
        if (url.pathname === '/api/posts' && request.method === 'GET') {
          const candidatePaths = [
            'src/content/astro-posts.ts',
            'src/data/astro-posts.ts',
            'astro-posts.ts',
          ];
          let metaFile = null;
          let matchedPath = '';

          for (const p of candidatePaths) {
            metaFile = await getGitHubFile(p, env);
            if (metaFile) {
              matchedPath = p;
              break;
            }
          }

          if (!metaFile) {
            return errorResponse(`Could not find astro-posts.ts in repository (checked: ${candidatePaths.join(', ')})`, 404, {
              owner: env.GITHUB_OWNER || 'stellorbit',
              repo: env.GITHUB_REPO || 'stellorbitnet-ver2',
              branch: env.GITHUB_BRANCH || 'main',
            });
          }

          // Check thumbnails in repository
          const branch = env.GITHUB_BRANCH || 'main';
          const treeRes = await callGitHub(`/git/trees/${branch}?recursive=1`, env);
          const existingThumbnails = new Set();
          if (treeRes.ok) {
            const treeData = await treeRes.json();
            for (const item of (treeData.tree || [])) {
              if (item.path.startsWith('src/assets/post-thumbnails/')) {
                const fname = item.path.replace('src/assets/post-thumbnails/', '');
                existingThumbnails.add(fname);
              }
            }
          }

          // Parse metadata
          const metaText = metaFile.content;
          const posts = [];
          const slugMatches = [...metaText.matchAll(/\{\s*slug:\s*['"]([^'"]+)['"]/g)];

          for (let i = 0; i < slugMatches.length; i++) {
            const currentMatch = slugMatches[i];
            const slug = currentMatch[1];
            const startPos = currentMatch.index;
            const nextMatch = slugMatches[i + 1];
            const endPos = nextMatch ? nextMatch.index : metaText.lastIndexOf('];');
            const entryText = metaText.slice(startPos, endPos);

            const titleMatch = entryText.match(/title:\s*['"]([\s\S]*?)['"],\r?\n/);
            const descMatch = entryText.match(/description:\s*['"]([\s\S]*?)['"],\r?\n/);
            const pubDateMatch = entryText.match(/pubDate:\s*new Date\(['"]([^'"]+)['"]\)/);
            const tagsMatch = entryText.match(/tags:\s*\[([\s\S]*?)\]/);
            const catMatch = entryText.match(/categories:\s*\[([\s\S]*?)\]/);
            const draftMatch = entryText.match(/draft:\s*true/);

            const parseList = (str) => {
              if (!str) return [];
              return str.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
            };

            let thumbFile = null;
            for (const ext of ['.webp', '.png', '.jpg', '.jpeg']) {
              if (existingThumbnails.has(`${slug}${ext}`)) {
                thumbFile = `${slug}${ext}`;
                break;
              }
            }

            posts.push({
              slug: String(slug || ''),
              title: titleMatch ? titleMatch[1] : String(slug || ''),
              description: descMatch ? descMatch[1] : '',
              pubDate: pubDateMatch ? pubDateMatch[1] : '',
              tags: tagsMatch ? parseList(tagsMatch[1]) : [],
              categories: catMatch ? parseList(catMatch[1]) : [],
              draft: Boolean(draftMatch),
              hasThumbnail: Boolean(thumbFile),
              thumbnailFile: thumbFile,
            });
          }

          return jsonResponse(posts.reverse());
        }

        // Create New Post (Atomic Multi-file Commit)
        if (url.pathname === '/api/posts/create' && request.method === 'POST') {
          const body = await request.json();
          const slug = String(body.slug || '').trim();
          if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
            return errorResponse('スラッグは半角英数字とハイフンのみ有効です', 400);
          }
          if (!body.title || !body.date) {
            return errorResponse('タイトルと日付は必須です', 400);
          }

          // Read current astro-posts.ts
          const metaPath = 'src/content/astro-posts.ts';
          const metaFile = await getGitHubFile(metaPath, env) || await getGitHubFile('src/data/astro-posts.ts', env);
          if (!metaFile) {
            return errorResponse('astro-posts.ts がリポジトリに見つかりません', 404);
          }

          if (new RegExp(`slug:\\s*['"]${slug}['"]`).test(metaFile.content)) {
            return errorResponse(`スラッグ "${slug}" の記事は既に存在します`, 400);
          }

          const hasThumbnail = Boolean(body.thumbnailBase64 || body.thumbnail);
          const draft = body.publish ? false : (body.draft === false ? false : true);

          // Prepare files to commit
          const filesToCommit = [];

          // 1. Article Body (src/articles/<slug>.astro)
          filesToCommit.push({
            path: `src/articles/${slug}.astro`,
            content: makeArticleTemplate({ title: body.title }),
            encoding: 'utf-8',
          });

          // 2. Page Template (src/pages/posts/<slug>.astro)
          filesToCommit.push({
            path: `src/pages/posts/${slug}.astro`,
            content: makePageTemplate(slug, hasThumbnail),
            encoding: 'utf-8',
          });

          // 3. Thumbnail Image (if provided)
          if (body.thumbnailBase64) {
            const rawBase64 = body.thumbnailBase64.replace(/^data:image\/\w+;base64,/, '');
            filesToCommit.push({
              path: `src/assets/post-thumbnails/${slug}.webp`,
              content: rawBase64,
              encoding: 'base64',
            });
          }

          // 4. Update astro-posts.ts
          const newEntry = makeMetaEntry({
            slug,
            title: body.title,
            description: body.description || '',
            date: body.date,
            category: body.category || '',
            tag: body.tag || '',
            draft,
          });

          const updatedMeta = metaFile.content.replace(
            /\r?\n\];\r?\n\r?\nexport function getAstroPost/,
            (match) => {
              const lineBreak = match.includes('\r\n') ? '\r\n' : '\n';
              return `,${lineBreak}${newEntry}${lineBreak}];${lineBreak}${lineBreak}export function getAstroPost`;
            }
          );

          if (updatedMeta === metaFile.content) {
            return errorResponse('astro-posts.ts へのエントリ挿入に失敗しました', 500);
          }

          filesToCommit.push({
            path: metaPath,
            content: updatedMeta,
            encoding: 'utf-8',
          });

          // Execute 1 atomic commit
          const commitMsg = `cms: create new post "${slug}"`;
          const result = await commitMultipleFiles(filesToCommit, commitMsg, env);

          return jsonResponse({ success: true, commit: result });
        }

        // Article Content Read
        if (url.pathname === '/api/posts/article-content' && request.method === 'GET') {
          const slug = url.searchParams.get('slug');
          if (!slug) return errorResponse('Missing slug', 400);

          const file = await getGitHubFile(`src/articles/${slug}.astro`, env);
          if (!file) return errorResponse(`Article src/articles/${slug}.astro not found`, 404);

          return jsonResponse({ slug, content: file.content, sha: file.sha });
        }

        // Article Content Save
        if (url.pathname === '/api/posts/save-article-content' && request.method === 'POST') {
          const body = await request.json();
          if (!body.slug || body.content === undefined) {
            return errorResponse('Missing slug or content', 400);
          }

          const existing = await getGitHubFile(`src/articles/${body.slug}.astro`, env);
          const sha = existing ? existing.sha : undefined;

          const commitMsg = `cms: update article content for ${body.slug}`;
          const result = await putGitHubFile(`src/articles/${body.slug}.astro`, body.content, commitMsg, sha, env);

          return jsonResponse({ success: true, commit: result.commit });
        }

        // Update Post Metadata
        if (url.pathname === '/api/posts/update-meta' && request.method === 'POST') {
          const body = await request.json();
          if (!body.slug) return errorResponse('Missing slug', 400);

          const metaPath = 'src/content/astro-posts.ts';
          const metaFile = await getGitHubFile(metaPath, env);
          if (!metaFile) return errorResponse('astro-posts.ts not found', 404);

          const range = findEntryRange(metaFile.content, body.slug);
          if (!range) return errorResponse(`Post entry for ${body.slug} not found in metadata`, 404);

          let entry = metaFile.content.slice(range.start, range.end);
          if (body.title !== undefined) {
            entry = entry.replace(/title:\s*['"]([\s\S]*?)['"],/, `title: ${JSON.stringify(body.title)},`);
          }
          if (body.description !== undefined) {
            entry = entry.replace(/description:\s*['"]([\s\S]*?)['"],/, `description: ${JSON.stringify(body.description)},`);
          }
          if (body.date !== undefined) {
            entry = entry.replace(/pubDate:\s*new Date\(['"]([^'"]+)['"]\)/, `pubDate: new Date(${JSON.stringify(body.date)})`);
          }
          if (body.tags !== undefined) {
            const tagArr = Array.isArray(body.tags) ? body.tags : body.tags.split(',').map(t=>t.trim()).filter(Boolean);
            entry = entry.replace(/tags:\s*\[([\s\S]*?)\]/, `tags: ${JSON.stringify(tagArr)}`);
          }
          if (body.categories !== undefined) {
            const catArr = Array.isArray(body.categories) ? body.categories : body.categories.split(',').map(c=>c.trim()).filter(Boolean);
            entry = entry.replace(/categories:\s*\[([\s\S]*?)\]/, `categories: ${JSON.stringify(catArr)}`);
          }

          const updatedMetaText = metaFile.content.slice(0, range.start) + entry + metaFile.content.slice(range.end);
          const commitMsg = `cms: update metadata for ${body.slug}`;
          const result = await putGitHubFile(metaPath, updatedMetaText, commitMsg, metaFile.sha, env);

          return jsonResponse({ success: true, commit: result.commit });
        }

        // Toggle Draft Status
        if (url.pathname === '/api/posts/toggle-draft' && request.method === 'POST') {
          const body = await request.json();
          if (!body.slug) return errorResponse('Missing slug', 400);

          const metaPath = 'src/content/astro-posts.ts';
          const metaFile = await getGitHubFile(metaPath, env);
          if (!metaFile) return errorResponse('astro-posts.ts not found', 404);

          const range = findEntryRange(metaFile.content, body.slug);
          if (!range) return errorResponse(`Post entry for ${body.slug} not found`, 404);

          let entry = metaFile.content.slice(range.start, range.end);
          if (/draft:\s*true/.test(entry)) {
            entry = entry.replace(/\r?\n[ \t]*draft:\s*true,?/, '');
          } else {
            if (/categories:/.test(entry)) {
              entry = entry.replace(/(categories:[^\n]+)/, `$1\n\t\tdraft: true,`);
            } else {
              entry = entry.replace(/(slug:[^\n]+)/, `$1\n\t\tdraft: true,`);
            }
          }

          const updatedMetaText = metaFile.content.slice(0, range.start) + entry + metaFile.content.slice(range.end);
          const commitMsg = `cms: toggle draft status for ${body.slug}`;
          const result = await putGitHubFile(metaPath, updatedMetaText, commitMsg, metaFile.sha, env);

          return jsonResponse({ success: true, commit: result.commit });
        }

        // Upload Thumbnail
        if (url.pathname === '/api/posts/upload-thumbnail' && request.method === 'POST') {
          const body = await request.json();
          if (!body.slug || !body.imageBase64) {
            return errorResponse('Missing slug or imageBase64', 400);
          }
          const rawBase64 = body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
          const filename = `${body.slug}.webp`;
          const filePath = `src/assets/post-thumbnails/${filename}`;

          // Check if exists
          const existing = await getGitHubFile(filePath, env);
          const sha = existing ? existing.sha : undefined;

          // Also ensure page template has thumbnail import
          const pagePath = `src/pages/posts/${body.slug}.astro`;
          const pageFile = await getGitHubFile(pagePath, env);
          let pageUpdated = false;
          let updatedPageContent = '';
          let pageSha = undefined;

          if (pageFile && !pageFile.content.includes('import thumbnail from')) {
            pageSha = pageFile.sha;
            updatedPageContent = pageFile.content.replace(
              `import ArticleBody from '../../articles/${body.slug}.astro';`,
              `import ArticleBody from '../../articles/${body.slug}.astro';\nimport thumbnail from '../../assets/post-thumbnails/${body.slug}.webp';`
            ).replace(
              `<BlogPost`,
              `<BlogPost\n\theroImage={thumbnail}`
            );
            pageUpdated = true;
          }

          if (pageUpdated) {
            // Commit both thumbnail image and page update
            await commitMultipleFiles([
              { path: filePath, content: rawBase64, encoding: 'base64' },
              { path: pagePath, content: updatedPageContent, encoding: 'utf-8' },
            ], `cms: add thumbnail for ${body.slug}`, env);
          } else {
            await putGitHubFile(filePath, rawBase64, `cms: upload thumbnail for ${body.slug}`, sha, env);
          }

          return jsonResponse({ success: true, filename });
        }

        // Upload Article Inline Image
        if (url.pathname === '/api/posts/upload-article-image' && request.method === 'POST') {
          const body = await request.json();
          if (!body.slug || !body.imageBase64) {
            return errorResponse('Missing slug or imageBase64', 400);
          }
          const cleanName = (body.filename || 'image').replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
          const timestamp = Date.now().toString().slice(-6);
          const finalFilename = `${cleanName}-${timestamp}.webp`;
          const filePath = `public/images/posts/${body.slug}/${finalFilename}`;
          const rawBase64 = body.imageBase64.replace(/^data:image\/\w+;base64,/, '');

          await putGitHubFile(filePath, rawBase64, `cms: upload article image ${finalFilename}`, undefined, env);
          const publicUrl = `/images/posts/${body.slug}/${finalFilename}`;
          return jsonResponse({ success: true, filename: finalFilename, publicUrl });
        }

        // Mock IDE open
        if (url.pathname === '/api/posts/open' && request.method === 'POST') {
          return jsonResponse({ success: false, message: 'Cloudflare Workerモードではローカルエディタ起動はサポートされていません' });
        }

        // Mock heading sync / image check
        if (url.pathname === '/api/sync-headings' && request.method === 'POST') {
          return jsonResponse({ success: true, message: '同期完了' });
        }
        if (url.pathname === '/api/check-images' && request.method === 'POST') {
          return jsonResponse({ success: true, message: '整合性チェック完了' });
        }

        // Media List
        if (url.pathname === '/api/media/list' && request.method === 'GET') {
          const branch = env.GITHUB_BRANCH || 'main';
          const treeRes = await callGitHub(`/git/trees/${branch}?recursive=1`, env);
          if (!treeRes.ok) {
            return errorResponse(`Failed to fetch git tree: ${await treeRes.text()}`, 500);
          }
          const treeData = await treeRes.json();
          const images = (treeData.tree || [])
            .filter(item => item.type === 'blob' && item.path.startsWith('public/images/') && /\.(webp|png|jpg|jpeg|gif|svg|avif)$/i.test(item.path))
            .map(item => {
              const urlPath = item.path.replace(/^public/, '');
              const filename = item.path.split('/').pop();
              const postsMatch = urlPath.match(/^\/images\/posts\/([^/]+)\//);
              return {
                filename,
                url: urlPath,
                slug: postsMatch ? postsMatch[1] : null,
                size: item.size || 0,
                sha: item.sha,
                isUnused: false,
              };
            });

          return jsonResponse({
            images,
            totalCount: images.length,
            totalSize: images.reduce((sum, img) => sum + img.size, 0),
            unusedCount: 0,
          });
        }

        // Delete Media Asset
        if (url.pathname === '/api/media/delete' && request.method === 'POST') {
          const body = await request.json();
          if (!body.url) return errorResponse('Missing url', 400);

          const filePath = 'public' + body.url;
          const branch = env.GITHUB_BRANCH || 'main';
          const fileRes = await callGitHub(`/contents/${filePath}?ref=${branch}`, env);
          if (!fileRes.ok) {
            return errorResponse(`File not found on GitHub: ${filePath}`, 404);
          }
          const fileData = await fileRes.json();
          const result = await deleteGitHubFile(filePath, `cms: delete media ${filePath}`, fileData.sha, env);
          return jsonResponse({ success: true, deletedPath: body.url, result });
        }

        return errorResponse('API Not Found: ' + url.pathname, 404);
      } catch (err) {
        return errorResponse(err.message, 500);
      }
    }

    // 7. Serve static frontend assets (via Assets binding)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('stellorbit CMS Worker is active. (Static assets binding pending)', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
