import { spawn } from 'node:child_process';
import http from 'node:http';

async function testApi() {
  console.log('--- Starting CMS Server for API Verification ---');
  const cms = spawn('node', ['./scripts/dev-cms.mjs'], {
    cwd: 'H:/CMS-Stellorbit',
    stdio: 'inherit'
  });

  await new Promise(r => setTimeout(r, 1500));

  function requestJson(urlPath) {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:8322${urlPath}`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            reject(new Error(`Failed to parse JSON (status ${res.statusCode}): ${data}`));
          }
        });
      }).on('error', reject);
    });
  }

  try {
    console.log('Testing GET /api/media/list...');
    const mediaListRes = await requestJson('/api/media/list');
    console.log('GET /api/media/list status:', mediaListRes.status);
    console.log('Total images found:', mediaListRes.body.totalCount);
    console.log('Total size (bytes):', mediaListRes.body.totalSize);
    console.log('Unused count:', mediaListRes.body.unusedCount);

    if (mediaListRes.status !== 200 || typeof mediaListRes.body.totalCount !== 'number') {
      throw new Error('media/list verification failed');
    }

    console.log('Testing GET /api/media/unused...');
    const unusedRes = await requestJson('/api/media/unused');
    console.log('GET /api/media/unused status:', unusedRes.status);
    console.log('Unused images count:', unusedRes.body.totalCount);

    if (unusedRes.status !== 200) {
      throw new Error('media/unused verification failed');
    }

    console.log('✅ Phase 3 Backend Media APIs verified successfully!');
  } finally {
    cms.kill('SIGINT');
  }
}

testApi().catch(err => {
  console.error('API Verification error:', err);
  process.exit(1);
});
