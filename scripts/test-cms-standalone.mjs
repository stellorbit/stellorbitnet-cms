import { spawn } from 'node:child_process';
import http from 'node:http';

const TEST_PORT = Number(process.env.CMS_PORT) || 8322;

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data, json: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log(`[Test] Starting dev-cms.mjs on port ${TEST_PORT}...`);
  const cmsProc = spawn('node', ['./scripts/dev-cms.mjs'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, CMS_PORT: String(TEST_PORT) }
  });

  try {
    let health = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 400));
      try {
        health = await get(`http://127.0.0.1:${TEST_PORT}/api/health`);
        if (health.status === 200) break;
      } catch {
        // Retry
      }
    }

    if (!health || health.status !== 200) {
      throw new Error(`CMS failed to respond to /api/health on port ${TEST_PORT}`);
    }
    console.log('[Test] /api/health OK:', health.json);

    const posts = await get(`http://127.0.0.1:${TEST_PORT}/api/posts`);
    if (posts.status !== 200 || !Array.isArray(posts.json)) {
      throw new Error('/api/posts failed or returned invalid data');
    }
    console.log(`[Test] /api/posts OK: Retrieved ${posts.json.length} posts.`);
    if (posts.json.length > 0) {
      console.log(`[Test] First post: slug="${posts.json[0].slug}", title="${posts.json[0].title}"`);
    }

    const html = await get(`http://127.0.0.1:${TEST_PORT}/`);
    if (html.status !== 200 || !html.body.includes('<!DOCTYPE html>')) {
      throw new Error(`GET / failed (status ${html.status})`);
    }
    console.log('[Test] GET / OK: HTML template served.');

    console.log('\n✅ All standalone CMS tests passed successfully!');
  } finally {
    console.log('[Test] Terminating CMS test process...');
    cmsProc.kill();
    await new Promise(r => setTimeout(r, 600));
  }
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
