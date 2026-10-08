/**
 * Cloudflare Worker for stellorbit.net CMS
 * Handles GitHub REST API proxy and static asset serving
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

// GitHub API Helpers
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

// Fetch file contents (text) from GitHub
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
  // UTF-8 decode
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

// Commit/Create/Update file on GitHub
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

  const body = {
    message,
    content: base64Content,
    branch,
  };
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

// Delete file on GitHub
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

    // 2. Serve thumbnails from GitHub (src/assets/post-thumbnails/<file>)
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
            'Cache-Control': 'public, max-age=86400',
            ...CORS_HEADERS,
          },
        });
      } catch (err) {
        return new Response('Thumbnail Error: ' + err.message, { status: 500, headers: CORS_HEADERS });
      }
    }

    // 3. Serve public images from GitHub (public/images/<file>)
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
            'Cache-Control': 'public, max-age=86400',
            ...CORS_HEADERS,
          },
        });
      } catch (err) {
        return new Response('Image Error: ' + err.message, { status: 500, headers: CORS_HEADERS });
      }
    }

    // 4. API Routing
    if (url.pathname.startsWith('/api/')) {
      try {
        // Fetch Post Metadata
        if (url.pathname === '/api/posts' && request.method === 'GET') {
          // Search candidates for astro-posts.ts
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

          // Check available thumbnails in repository
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

          // Fetch current file to get sha
          const existing = await getGitHubFile(`src/articles/${body.slug}.astro`, env);
          const sha = existing ? existing.sha : undefined;

          const commitMsg = `cms: update article content for ${body.slug}`;
          const result = await putGitHubFile(`src/articles/${body.slug}.astro`, body.content, commitMsg, sha, env);

          return jsonResponse({ success: true, commit: result.commit });
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
          // Get SHA of file
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

    // 5. Serve static frontend assets (via Assets binding)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('stellorbit CMS Worker is active. (Static assets binding pending)', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
