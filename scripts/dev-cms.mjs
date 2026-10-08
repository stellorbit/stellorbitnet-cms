import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, exec, execSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// 自動的に.envをロード (Node 20.12+)
try {
  process.loadEnvFile?.();
} catch {
  // .envが存在しない場合は無視
}

const cmsRoot = path.resolve(import.meta.dirname, '..');
const DEFAULT_SITE_ROOT = path.resolve(cmsRoot, '../Website-Stellorbit');
const siteRoot = process.env.WEBSITE_ROOT ? path.resolve(process.env.WEBSITE_ROOT) : DEFAULT_SITE_ROOT;
const DEFAULT_PORT = Number(process.env.CMS_PORT) || 8322;
const ASTRO_PORT = 4321;
const META_PATH = path.join(siteRoot, 'src', 'content', 'astro-posts.ts');
const HTML_PATH = path.join(cmsRoot, 'scripts', 'dev-cms.html');
const THUMBNAIL_DIR = path.join(siteRoot, 'src', 'assets', 'post-thumbnails');
const ARTICLES_DIR = path.join(siteRoot, 'src', 'articles');
const PUBLIC_IMAGES_DIR = path.join(siteRoot, 'public', 'images', 'posts');

let astroDevChild = null;

// Helper to open file in editor
async function openInEditor(filePath) {
  const absolutePath = path.resolve(filePath);
  const normalizedPath = absolutePath.replace(/\\/g, '/');
  
  try {
    if (process.platform === 'win32') {
      await execAsync(`code "${absolutePath}"`);
      return { success: true, method: 'code', path: absolutePath };
    }
  } catch {
    // Ignore
  }
  
  return { 
    success: true, 
    path: absolutePath, 
    vscodeUrl: `vscode://file/${normalizedPath}` 
  };
}

// Check if Astro dev server on port 4321 is responding
function isAstroDevServerRunning() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${ASTRO_PORT}`, () => {
      resolve(true);
      req.destroy();
    });
    req.on('error', () => {
      resolve(false);
    });
    req.setTimeout(1200, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Start Astro Dev Server strictly on port 4321
async function startAstroDevServer() {
  const running = await isAstroDevServerRunning();
  if (running) {
    return { success: true, message: 'Astro dev server is already running.', port: ASTRO_PORT };
  }

  const isWin = process.platform === 'win32';
  const pnpmCmd = isWin ? 'pnpm.cmd' : 'pnpm';
  
  astroDevChild = spawn(pnpmCmd, ['run', 'dev', '--port', String(ASTRO_PORT)], {
    cwd: siteRoot,
    stdio: 'ignore',
    shell: false,
    detached: false
  });

  astroDevChild.on('error', (err) => {
    console.error('Failed to start astro dev process:', err);
  });

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 600));
    if (await isAstroDevServerRunning()) {
      return { success: true, port: ASTRO_PORT };
    }
  }

  return { success: true, port: ASTRO_PORT, starting: true };
}

// Stop Astro dev server if started by CMS
function stopAstroDevServer() {
  if (astroDevChild) {
    try {
      astroDevChild.kill();
    } catch {
      // Ignore
    }
    astroDevChild = null;
  }
}


// Check if thumbnail image file exists for a slug
async function hasThumbnailFile(slug) {
  const extensions = ['.webp', '.png', '.jpg', '.jpeg'];
  for (const ext of extensions) {
    try {
      await fs.access(path.join(THUMBNAIL_DIR, `${slug}${ext}`));
      return `${slug}${ext}`;
    } catch {
      // Ignore
    }
  }
  return null;
}

// Parse posts from astro-posts.ts
async function getPosts() {
  try {
    const metaText = await fs.readFile(META_PATH, 'utf8');
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
        return str.split(',')
          .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
      };

      const thumbFile = await hasThumbnailFile(slug);

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
    
    return posts.reverse();
  } catch (err) {
    console.error('Error reading posts:', err);
    return [];
  }
}

// Find range of a specific entry in astro-posts.ts
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

// Toggle draft status
async function toggleDraft(slug) {
  const metaText = await fs.readFile(META_PATH, 'utf8');
  const range = findEntryRange(metaText, slug);
  if (!range) throw new Error(`Post entry for "${slug}" not found.`);

  let entry = metaText.slice(range.start, range.end);
  if (/draft:\s*true/.test(entry)) {
    entry = entry.replace(/\r?\n[ \t]*draft:\s*true,?/, '');
  } else {
    if (/categories:/.test(entry)) {
      entry = entry.replace(/(categories:[^\n]+)/, `$1\n\t\tdraft: true,`);
    } else {
      entry = entry.replace(/(slug:[^\n]+)/, `$1\n\t\tdraft: true,`);
    }
  }

  const updatedMetaText = metaText.slice(0, range.start) + entry + metaText.slice(range.end);
  await fs.writeFile(META_PATH, updatedMetaText, 'utf8');
}

// Update metadata in astro-posts.ts
async function updatePostMeta(slug, newData) {
  const metaText = await fs.readFile(META_PATH, 'utf8');
  const range = findEntryRange(metaText, slug);
  if (!range) throw new Error(`Post entry for "${slug}" not found.`);

  let entry = metaText.slice(range.start, range.end);

  if (newData.title !== undefined) {
    entry = entry.replace(/title:\s*['"]([\s\S]*?)['"],/, `title: ${JSON.stringify(newData.title)},`);
  }
  if (newData.description !== undefined) {
    entry = entry.replace(/description:\s*['"]([\s\S]*?)['"],/, `description: ${JSON.stringify(newData.description)},`);
  }
  if (newData.date !== undefined) {
    entry = entry.replace(/pubDate:\s*new Date\(['"]([^'"]+)['"]\)/, `pubDate: new Date(${JSON.stringify(newData.date)})`);
  }
  if (newData.tags !== undefined) {
    const tagArr = Array.isArray(newData.tags) ? newData.tags : newData.tags.split(',').map(t=>t.trim()).filter(Boolean);
    entry = entry.replace(/tags:\s*\[([\s\S]*?)\]/, `tags: ${JSON.stringify(tagArr)}`);
  }
  if (newData.categories !== undefined) {
    const catArr = Array.isArray(newData.categories) ? newData.categories : newData.categories.split(',').map(c=>c.trim()).filter(Boolean);
    entry = entry.replace(/categories:\s*\[([\s\S]*?)\]/, `categories: ${JSON.stringify(catArr)}`);
  }

  const updatedMetaText = metaText.slice(0, range.start) + entry + metaText.slice(range.end);
  await fs.writeFile(META_PATH, updatedMetaText, 'utf8');
}

// Enable thumbnail in src/pages/posts/<slug>.astro
async function ensureThumbnailInPage(slug) {
  const pagePath = path.join(siteRoot, 'src', 'pages', 'posts', `${slug}.astro`);
  try {
    let pageContent = await fs.readFile(pagePath, 'utf8');
    if (!pageContent.includes('import thumbnail from')) {
      pageContent = pageContent.replace(
        `import ArticleBody from '../../articles/${slug}.astro';`,
        `import ArticleBody from '../../articles/${slug}.astro';\nimport thumbnail from '../../assets/post-thumbnails/${slug}.webp';`
      );
      pageContent = pageContent.replace(
        `<BlogPost`,
        `<BlogPost\n\theroImage={thumbnail}`
      );
      await fs.writeFile(pagePath, pageContent, 'utf8');
    }
  } catch (e) {
    console.error(`Could not update page template for ${slug}:`, e);
  }
}

// Upload & process thumbnail
async function processThumbnailUpload(slug, base64Data) {
  await fs.mkdir(THUMBNAIL_DIR, { recursive: true });
  const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const targetPath = path.join(THUMBNAIL_DIR, `${slug}.webp`);
  
  await sharp(buffer)
    .resize(1200, 630, { fit: 'cover', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toFile(targetPath);
    
  await ensureThumbnailInPage(slug);
  return `${slug}.webp`;
}

// Upload & process article inline image to public/images/posts/<slug>/<name>.webp
async function processArticleImageUpload(slug, base64Data, filename) {
  const targetDir = path.join(PUBLIC_IMAGES_DIR, slug);
  await fs.mkdir(targetDir, { recursive: true });
  
  const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  
  const cleanName = (filename || 'image').replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const timestamp = Date.now().toString().slice(-6);
  const finalFilename = `${cleanName}-${timestamp}.webp`;
  const targetPath = path.join(targetDir, finalFilename);

  await sharp(buffer)
    .resize(1600, 1200, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toFile(targetPath);

  const publicUrl = `/images/posts/${slug}/${finalFilename}`;
  return { filename: finalFilename, publicUrl };
}

// OGP Metadata Fetcher for Link Cards
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

  // SSRF対策: ローカルおよび内部IPへのアクセス抑止
  const host = targetUrl.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
  ) {
    throw new Error('内部アドレスへのアクセスは禁止されています。');
  }

  const response = await fetch(targetUrl.href, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(6000),
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`サイトからの応答エラー (ステータス: ${response.status})`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    return {
      url: targetUrl.href,
      title: targetUrl.hostname,
      description: '',
      image: '',
      siteName: targetUrl.hostname,
      domain: targetUrl.hostname
    };
  }

  // メモリ保護のため先頭256KBのみ取得
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  const MAX_BYTES = 256 * 1024;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalBytes += value.length;
    if (totalBytes >= MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }

  const buffer = Buffer.concat(chunks);
  const charsetMatch = contentType.match(/charset=([^;]+)/i) || buffer.toString('ascii').match(/<meta[^>]+charset=['"]?([^'"/>\s]+)/i);
  const encoding = charsetMatch ? charsetMatch[1].trim().toLowerCase() : 'utf-8';
  let html = '';
  try {
    const decoder = new TextDecoder(encoding);
    html = decoder.decode(buffer);
  } catch {
    html = buffer.toString('utf8');
  }

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
      .replace(/&#39;/g, "'")
      .replace(/&#x26;/g, '&')
      .replace(/&#x27;/g, "'");
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
    domain: targetUrl.hostname
  };
}


// =========================================================
// Phase 3: Media Asset Scanner & Management Helpers
// =========================================================
async function getMediaAssets(filterSlug = null) {
  const images = [];
  const publicImagesDir = path.join(siteRoot, 'public', 'images');
  
  // 1. Scan articles to build reference map
  const usedImagesMap = new Map(); // urlPath => Set of slugs
  const articlesDir = path.join(siteRoot, 'src', 'articles');
  try {
    const articleFiles = await fs.readdir(articlesDir);
    for (const file of articleFiles) {
      if (file.endsWith('.astro')) {
        const slug = file.replace(/\.astro$/, '');
        const content = await fs.readFile(path.join(articlesDir, file), 'utf8');
        // Match both HTML src="/images/..." and Markdown ![](/images/...)
        const matches = content.matchAll(/(?:src=["']|!\[.*?\]\()(?<path>\/images\/[^"')\s]+)/g);
        for (const m of matches) {
          const imgPath = m.groups.path;
          if (!usedImagesMap.has(imgPath)) {
            usedImagesMap.set(imgPath, new Set());
          }
          usedImagesMap.get(imgPath).add(slug);
        }
      }
    }
  } catch (e) {
    console.error('Error scanning articles for image references:', e);
  }

  // 2. Scan public/images directory recursively
  async function scanDir(currentDir, relativePrefix = '/images') {
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const urlPath = `${relativePrefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await scanDir(fullPath, urlPath);
        } else if (entry.isFile() && /\.(webp|png|jpg|jpeg|gif|svg|avif)$/i.test(entry.name)) {
          const stat = await fs.stat(fullPath);
          let itemSlug = null;
          const postsMatch = urlPath.match(/^\/images\/posts\/([^/]+)\//);
          if (postsMatch) {
            itemSlug = postsMatch[1];
          }

          if (filterSlug && itemSlug !== filterSlug) {
            continue;
          }

          const usedBy = usedImagesMap.has(urlPath) ? Array.from(usedImagesMap.get(urlPath)) : [];

          images.push({
            filename: entry.name,
            url: urlPath,
            slug: itemSlug,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            usedBy,
            isUnused: usedBy.length === 0
          });
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  await scanDir(publicImagesDir, '/images');

  // Sort by mtime desc
  images.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

  const totalSize = images.reduce((sum, img) => sum + img.size, 0);
  const unusedCount = images.filter(img => img.isUnused).length;

  return {
    images,
    totalCount: images.length,
    totalSize,
    unusedCount
  };
}

async function deleteMediaAsset(relativeUrl) {
  const decodedPath = decodeURIComponent(relativeUrl);
  if (!decodedPath.startsWith('/images/')) {
    throw new Error('不正な画像パスです');
  }
  
  // 拡張子制限（画像ファイルのみ許可）
  if (!/\.(webp|png|jpg|jpeg|gif|svg|avif)$/i.test(decodedPath)) {
    throw new Error('削除対象は画像ファイルのみに限定されています');
  }

  const publicImagesRoot = path.resolve(siteRoot, 'public', 'images');
  const diskPath = path.resolve(publicImagesRoot, decodedPath.replace(/^\/images\/?/, ''));

  // パストラバーサル防止チェック
  if (!diskPath.startsWith(publicImagesRoot)) {
    throw new Error('許可されていないパスへのアクセスです');
  }

  await fs.unlink(diskPath);
  return { success: true, deletedPath: relativeUrl };
}

// Request Handler
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  // Set CORS headers for desktop GUI / WebView interoperability
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const sendJSON = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  const getBody = () => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

  // Health check API for Splash screen
  if (method === 'GET' && url.pathname === '/api/health') {
    const astroRunning = await isAstroDevServerRunning();
    return sendJSON({
      status: 'ok',
      cmsPort: Number(process.env.CMS_PORT) || 8322,
      astroRunning,
      astroPort: ASTRO_PORT,
      uptime: process.uptime()
    });
  }

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/editor')) {
    try {
      const html = await fs.readFile(HTML_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('HTML Template missing');
    }
  }

  // Dev server management APIs
  if (method === 'GET' && url.pathname === '/api/dev-server/status') {
    const running = await isAstroDevServerRunning();
    return sendJSON({ running, port: ASTRO_PORT });
  }

  if (method === 'POST' && url.pathname === '/api/dev-server/start') {
    const result = await startAstroDevServer();
    return sendJSON(result);
  }

  // OGP fetch API for Link Cards
  if (method === 'GET' && url.pathname === '/api/ogp') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return sendJSON({ error: 'URLパラメータが必要です' }, 400);

    try {
      const data = await fetchOgpData(targetUrl);
      return sendJSON(data);
    } catch (err) {
      try {
        const u = new URL(targetUrl);
        return sendJSON({
          url: u.href,
          title: u.hostname,
          description: '',
          image: '',
          siteName: u.hostname,
          domain: u.hostname
        });
      } catch {
        return sendJSON({ error: err.message }, 400);
      }
    }
  }

  // Serve thumbnails
  if (method === 'GET' && url.pathname.startsWith('/api/thumbnails/')) {
    const filename = url.pathname.replace('/api/thumbnails/', '');
    const filepath = path.join(THUMBNAIL_DIR, filename);
    try {
      const imgBuffer = await fs.readFile(filepath);
      const ext = path.extname(filename).toLowerCase();
      const contentType = ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      return res.end(imgBuffer);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
  }

  // Serve public images (/images/...)
  if (method === 'GET' && url.pathname.startsWith('/images/')) {
    try {
      const decodedPath = decodeURIComponent(url.pathname);
      const publicImagesRoot = path.resolve(siteRoot, 'public', 'images');
      const relativePath = decodedPath.replace(/^\/images\/?/, '');
      const fullPath = path.resolve(publicImagesRoot, relativePath);

      // パストラバーサル防止チェック: public/images 配下に収まっているか確認
      if (!fullPath.startsWith(publicImagesRoot)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Forbidden');
      }

      const imgBuffer = await fs.readFile(fullPath);
      const ext = path.extname(fullPath).toLowerCase();
      const mimeTypes = {
        '.webp': 'image/webp',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.gif': 'image/gif',
        '.avif': 'image/avif',
        '.ico': 'image/x-icon'
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      return res.end(imgBuffer);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Image Not Found');
    }
  }

  
  // Media Assets API (Phase 3)
  if (method === 'GET' && url.pathname === '/api/media/list') {
    try {
      const slug = url.searchParams.get('slug');
      const result = await getMediaAssets(slug);
      return sendJSON(result);
    } catch (err) {
      console.error('Error fetching media list:', err);
      return sendJSON({ error: err.message }, 500);
    }
  }

  if (method === 'GET' && url.pathname === '/api/media/unused') {
    try {
      const result = await getMediaAssets();
      const unusedOnly = result.images.filter(img => img.isUnused);
      return sendJSON({
        images: unusedOnly,
        totalCount: unusedOnly.length,
        totalSize: unusedOnly.reduce((sum, img) => sum + img.size, 0)
      });
    } catch (err) {
      console.error('Error fetching unused media:', err);
      return sendJSON({ error: err.message }, 500);
    }
  }

  if (method === 'POST' && url.pathname === '/api/media/delete') {
    try {
      const body = await getBody();
      if (!body.url) {
        return sendJSON({ error: 'URLが必要です' }, 400);
      }
      const result = await deleteMediaAsset(body.url);
      return sendJSON(result);
    } catch (err) {
      console.error('Error deleting media:', err);
      return sendJSON({ error: err.message }, 500);
    }
  }

  if (method === 'GET' && url.pathname === '/api/posts') {
    const posts = await getPosts();
    return sendJSON(posts);
  }

  // Article Content Read & Save APIs
  if (method === 'GET' && url.pathname === '/api/posts/article-content') {
    const slug = url.searchParams.get('slug');
    if (!slug) return sendJSON({ error: 'Missing slug' }, 400);

    const articlePath = path.join(ARTICLES_DIR, `${slug}.astro`);
    try {
      const content = await fs.readFile(articlePath, 'utf8');
      return sendJSON({ slug, content });
    } catch {
      return sendJSON({ error: `Article file ${slug}.astro not found.` }, 404);
    }
  }

  if (method === 'POST' && url.pathname === '/api/posts/save-article-content') {
    try {
      const body = await getBody();
      if (!body.slug || body.content === undefined) {
        return sendJSON({ error: 'Missing slug or content' }, 400);
      }

      const articlePath = path.join(ARTICLES_DIR, `${body.slug}.astro`);
      await fs.writeFile(articlePath, body.content, 'utf8');

      // Sync headings automatically
      try {
        const scriptPath = path.join(cmsRoot, 'scripts', 'sync-astro-post-headings.mjs');
        await execFileAsync('node', [scriptPath], { cwd: siteRoot });
      } catch (syncErr) {
        console.error('Heading sync failed after article save:', syncErr);
      }

      return sendJSON({ success: true });
    } catch (err) {
      console.error('Error saving article content:', err);
      return sendJSON({ error: err.message }, 500);
    }
  }

  // Article Inline Image Upload (WebP) API
  if (method === 'POST' && url.pathname === '/api/posts/upload-article-image') {
    try {
      const body = await getBody();
      if (!body.slug || !body.imageBase64) {
        return sendJSON({ error: 'Missing slug or image data' }, 400);
      }
      const result = await processArticleImageUpload(body.slug, body.imageBase64, body.filename);
      return sendJSON({ success: true, ...result });
    } catch (err) {
      console.error('Error uploading article image:', err);
      return sendJSON({ error: err.message }, 500);
    }
  }

  if (method === 'POST' && url.pathname === '/api/posts/create') {
    try {
      const body = await getBody();
      
      const scriptPath = path.join(cmsRoot, 'scripts', 'new-astro-post.mjs');
      const args = [
        scriptPath,
        '--slug', body.slug,
        '--title', body.title,
        '--description', body.description,
        '--date', body.date,
      ];
      if (body.category) args.push('--category', body.category);
      if (body.tag) args.push('--tag', body.tag);
      if (body.thumbnail || body.thumbnailBase64) args.push('--thumbnail');
      if (body.publish) args.push('--publish');

      const { stdout } = await execFileAsync('node', args, { cwd: siteRoot });

      if (body.thumbnailBase64) {
        await processThumbnailUpload(body.slug, body.thumbnailBase64);
      }

      return sendJSON({ success: true, output: stdout });
    } catch (err) {
      console.error('Error creating post:', err);
      return sendJSON({ error: err.stderr || err.stdout || err.message || 'Failed to create post' }, 400);
    }
  }

  if (method === 'POST' && url.pathname === '/api/posts/upload-thumbnail') {
    try {
      const body = await getBody();
      if (!body.slug || !body.imageBase64) {
        return sendJSON({ error: 'Missing slug or image data' }, 400);
      }
      const filename = await processThumbnailUpload(body.slug, body.imageBase64);
      return sendJSON({ success: true, filename });
    } catch (err) {
      console.error('Error uploading thumbnail:', err);
      return sendJSON({ error: err.message }, 500);
    }
  }

  if (method === 'POST' && url.pathname === '/api/posts/update-meta') {
    try {
      const body = await getBody();
      await updatePostMeta(body.slug, body);
      return sendJSON({ success: true });
    } catch (err) {
      return sendJSON({ error: err.message }, 500);
    }
  }

  if (method === 'POST' && url.pathname === '/api/posts/open') {
    try {
      const body = await getBody();
      const articlePath = path.join(siteRoot, 'src', 'articles', `${body.slug}.astro`);
      const result = await openInEditor(articlePath);
      return sendJSON(result);
    } catch (err) {
      return sendJSON({ error: err.message }, 500);
    }
  }

  if (method === 'POST' && url.pathname === '/api/posts/toggle-draft') {
    try {
      const body = await getBody();
      await toggleDraft(body.slug);
      return sendJSON({ success: true });
    } catch (err) {
      return sendJSON({ error: err.message }, 500);
    }
  }

  if (method === 'POST' && url.pathname === '/api/sync-headings') {
    try {
      const scriptPath = path.join(cmsRoot, 'scripts', 'sync-astro-post-headings.mjs');
      const { stdout } = await execFileAsync('node', [scriptPath], { cwd: siteRoot });
      return sendJSON({ success: true, output: stdout });
    } catch (err) {
      return sendJSON({ error: err.message }, 500);
    }
  }

  if (method === 'POST' && url.pathname === '/api/check-images') {
    try {
      const scriptPath = path.join(cmsRoot, 'scripts', 'check-image-references.mjs');
      const { stdout } = await execFileAsync('node', [scriptPath], { cwd: siteRoot });
      return sendJSON({ success: true, output: stdout });
    } catch (err) {
      return sendJSON({ error: err.message }, 500);
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Clean up child process on exit
process.on('SIGINT', () => { stopAstroDevServer(); process.exit(); });
process.on('SIGTERM', () => { stopAstroDevServer(); process.exit(); });

// Port fallback handler
function startServer(port) {
  server.removeAllListeners('error');
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} is in use, retrying on port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });
  server.listen(port, () => {
    console.log(`\n🚀 stellorbit.net 記事管理CMS running at: http://localhost:${port}\n`);
  });
}

startServer(DEFAULT_PORT);
