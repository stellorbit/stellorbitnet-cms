/* global window, document, DataTransfer, ClipboardEvent */
// CMSエディタの回帰検証。保存・アップロードAPIは模擬するため記事や画像は変更しない。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { verifyPublicFeatures, verifyPages, verifyWorker } from './verify-cms-public.mjs';

const root = process.cwd();
// 記事と固定ページは読み取りのみ（保存・アップロードのAPIは模擬する）
const siteRoot = path.resolve(process.env.WEBSITE_ROOT || path.join(root, '../stellorbitnet-ver2'));
const shotDir = process.env.VERIFY_SHOT_DIR || os.tmpdir();
let failures = 0;
let total = 0;

function check(name, ok, detail = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK ' : 'NG '} ${name}${ok || !detail ? '' : ` :: ${String(detail).slice(0, 400)}`}`);
}

function startServer() {
  const child = spawn(process.execPath, ['scripts/dev-cms.mjs'], {
    cwd: root, env: { ...process.env, CMS_PORT: '8397', WEBSITE_ROOT: siteRoot },
  });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (data) => {
      const match = String(data).match(/localhost:(\d+)/);
      if (match) resolve({ child, port: Number(match[1]) });
    });
    child.stderr.on('data', (data) => process.stderr.write(data));
    child.on('exit', (code) => reject(new Error(`server exited: ${code}`)));
  });
}

// fetchではHostやOriginを自由に指定できないため、httpで直接送る
function rawRequest(port, url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: url, method, headers }, (response) => {
      response.resume();
      resolve({ status: response.statusCode, allow: response.headers['access-control-allow-origin'] });
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function verifyOrigins(port) {
  const host = `localhost:${port}`;
  const send = (url, headers, method, body) => rawRequest(port, url, { method, headers: { host, ...headers }, body });
  const invalid = JSON.stringify({ slug: 'INVALID_SLUG!', content: 'x' });
  for (const origin of ['https://evil.example', 'null', `http://localhost:${port + 1}`, 'http://tauri.localhost']) {
    const read = await send('/api/posts', { origin });
    check(`別サイトからの読込を拒否: ${origin}`, read.status === 403 && read.allow === undefined, JSON.stringify(read));
    const write = await send('/api/posts/save-article-content', { origin, 'content-type': 'text/plain' }, 'POST', invalid);
    check(`別サイトからの書込を拒否: ${origin}`, write.status === 403, JSON.stringify(write));
  }
  const preflight = await send('/api/posts', { origin: 'https://evil.example' }, 'OPTIONS');
  check('別サイトの事前確認を拒否', preflight.status === 403);
  const noOrigin = await send('/api/posts', { 'sec-fetch-site': 'cross-site' });
  check('Originなしの別サイト読込を拒否', noOrigin.status === 403);
  const navigate = await send('/', { 'sec-fetch-site': 'cross-site' });
  check('画面への移動は可', navigate.status === 200);
  const rebinding = await rawRequest(port, '/api/posts', { headers: { host: `evil.example:${port}` } });
  check('不正なHostを拒否', rebinding.status === 403);
  for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`]) {
    const allowed = await send('/api/posts', { origin });
    check(`許可する画面: ${origin}`, allowed.status === 200 && allowed.allow === undefined, JSON.stringify(allowed));
  }
  const own = await send('/api/posts/save-article-content', { origin: `http://${host}`, 'content-type': 'application/json' }, 'POST', invalid);
  check('CMS画面の書込は受け付ける', own.status === 400);
}

async function verifyServer(base, port, slugs) {
  await verifyOrigins(port);
  const status = async (url, body) => (await fetch(base + url, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).status;
  check('不正slugの読込を拒否', (await status('/api/posts/article-content?slug=..%2F..%2Fpackage')) === 400);
  const bad = { slug: 'INVALID_SLUG!', content: 'x', imageBase64: 'x', title: 'x', description: 'x', date: '2026-01-01' };
  for (const route of ['save-article-content', 'upload-article-image', 'create', 'upload-thumbnail', 'update-meta', 'toggle-ai', 'open', 'toggle-draft']) {
    check(`不正slugを拒否: ${route}`, (await status(`/api/posts/${route}`, bad)) === 400);
  }
  check('固定ページの不正slugを拒否', (await status('/api/pages/content?slug=..%2F..%2Fpackage')) === 400
    && (await status('/api/pages/save', bad)) === 400);
  check('画像フォルダ外の削除を拒否', (await status('/api/media/delete', { url: '/images/../images-x/a.png' })) !== 200);
  check('既存slugは読込可', (await status(`/api/posts/article-content?slug=${slugs[0]}`)) === 200);
  for (const name of ['content', 'paste', 'blocks']) check(`script配信: ${name}`, (await status(`/cms/${name}.js`)) === 200);
  check('許可外ファイルは非公開', (await status('/scripts/dev-cms.mjs')) === 404);
  check('127.0.0.1で接続可', (await fetch(`http://127.0.0.1:${port}/api/posts`)).ok);
  const lan = Object.values(os.networkInterfaces()).flat().filter((n) => n.family === 'IPv4' && !n.internal);
  for (const net of lan) {
    const reachable = await fetch(`http://${net.address}:${port}/api/posts`, { signal: AbortSignal.timeout(1500) })
      .then(() => true, () => false);
    check('LANアドレスからは接続不可', !reachable, net.address);
  }
}

async function verifyArticles(page, base, slugs, saved) {
  for (const slug of slugs) {
    const raw = await fs.readFile(path.join(siteRoot, 'src', 'articles', `${slug}.astro`), 'utf8');
    await page.goto(`${base}/?editor=${slug}`);
    await page.waitForFunction(() => window.editorContentReady);
    const result = await page.evaluate((source) => {
      const C = window.CmsContent;
      const reason = C.detectSourceOnly(source);
      if (reason) return { reason, mode: window.currentEditorMode, content: window.getLatestContent() };
      const first = C.cleanHtml(source);
      const facts = (html) => {
        const t = C.parseArticle(html).content;
        t.querySelectorAll('iframe[data-tweet-id], .twitter-tweet-rendered').forEach((e) => e.remove());
        t.querySelectorAll('blockquote.twitter-tweet').forEach((e) => e.remove());
        const holder = document.createElement('div');
        holder.appendChild(document.importNode(t, true));
        holder.querySelectorAll('script, style').forEach((e) => e.remove());
        return { text: holder.textContent.replace(/\s+/g, ''), images: holder.querySelectorAll('img').length,
          links: holder.querySelectorAll('a[href]').length, headings: Array.from(holder.querySelectorAll('h1,h2,h3,h4')).filter((h) => h.id || h.textContent.trim()).length,
          figures: holder.querySelectorAll('figure').length,
          ids: Array.from(holder.querySelectorAll('[id]'), (e) => e.id).sort().join(' ') };
      };
      return { first, second: C.cleanHtml(first), before: facts(source), after: facts(first),
        live: window.getLatestContent(), mode: window.currentEditorMode };
    }, raw);
    if (result.reason) {
      check(`${slug}: ソース専用で原文維持`, result.mode === 'source' && result.content === raw, result.reason);
      saved.length = 0;
      await page.evaluate(() => window.saveArticleContent());
      check(`${slug}: 保存内容が原文と一致`, saved[0]?.content === raw);
      continue;
    }
    check(`${slug}: 文字・ID・画像・図・リンク・見出し数を維持`, JSON.stringify(result.before) === JSON.stringify(result.after),
      JSON.stringify([{ ...result.before, text: result.before.text.length }, { ...result.after, text: result.after.text.length }]));
    check(`${slug}: 再整形しても不変`, result.first === result.second);
    check(`${slug}: 画面経由の出力が一致`, result.live === result.first && result.mode === 'visual');
    check(`${slug}: 編集用の情報が残らない`,
      !/contenteditable|data-placeholder|data-cms-|cms-block|^<p><\/p>$|twitter-widget-\d|figure-action|is-selected/m.test(result.first));
    await fs.writeFile(path.join(shotDir, `${slug}.out.astro`), result.first);
  }
}

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function setup(page, html, selector, offset) {
  await page.evaluate(([markup, sel, at]) => {
    const canvas = document.getElementById('wysiwyg-canvas');
    canvas.innerHTML = markup;
    window.CmsBlocks.resetHistory();
    canvas.focus();
    if (sel) {
      const node = canvas.querySelector(sel).firstChild || canvas.querySelector(sel);
      window.getSelection().collapse(node, at < 0 ? node.textContent.length : at);
    }
  }, [html, selector, offset]);
}

async function paste(page, data, names = []) {
  await page.evaluate(async ([values, files, base64]) => {
    const transfer = new DataTransfer();
    Object.entries(values).forEach(([type, value]) => transfer.setData(type, value));
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    files.forEach((name) => transfer.items.add(new File([bytes], name, { type: 'image/png' })));
    document.getElementById('wysiwyg-canvas').dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    await window.CmsPaste.waitForUploads();
  }, [data, names, png]);
}

const output = (page) => page.evaluate(() => window.getLatestContent());
const order = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#wysiwyg-canvas > *'),
  (e) => e.textContent).filter(Boolean).join(','));

async function verifyPaste(page) {
  await setup(page, '<p>前半後半</p>', 'p', 2);
  await paste(page, {}, ['shot.png']);
  let out = await output(page);
  check('段落途中の画像貼付で段落を分割',
    /^<p>前半<\/p>\n<figure class="article-image-figure"><img [^>]*><figcaption [^>]*><\/figcaption><\/figure>\n<p>後半<\/p>\n$/.test(out), out);
  await page.keyboard.type('X');
  check('貼付後の入力は直後の段落へ', (await output(page)).includes('<p>X後半</p>'), await output(page));

  await setup(page, '<p>本文</p><p>次の段落</p>', 'p', -1);
  await paste(page, {}, ['a.png', 'b.png']);
  await page.keyboard.type('追記');
  out = await output(page);
  check('段落末尾の複数画像は順序維持し改行を作る',
    /<p>本文<\/p>\n<figure[\s\S]*?alt="a"[\s\S]*?alt="b"[\s\S]*?<\/figure>\n<p>追記(<br>)?<\/p>\n<p>次の段落<\/p>/.test(out), out);

  await setup(page, '<p>本文</p>', 'p', -1);
  await paste(page, {}, ['c.png']);
  await page.keyboard.press('Control+z');
  check('画像貼付をCtrl+Zで取り消し', (await output(page)) === '<p>本文</p>\n', await output(page));
  await page.keyboard.press('Control+y');
  check('Ctrl+Yでやり直し', (await output(page)).includes('alt="c"'), await output(page));

  await setup(page, '<p><br></p>', 'p', 0);
  await paste(page, { 'text/html': '<p>文章A</p><p>文章B <img src="file:///C:/x.png"></p>', 'text/plain': '文章A' }, ['word.png']);
  out = await output(page);
  check('文章と画像の同時貼付で文章を保持', out.includes('文章A') && out.includes('文章B') && !out.includes('<img'), out);

  await setup(page, '<h2 id="t">見出し</h2><p>本文</p>', 'h2', -1);
  await paste(page, { 'text/html': '<h2>追加<img src="/images/x.webp"></h2>', 'text/plain': '追加\n' });
  out = await output(page);
  check('見出しへの貼付は文字のみ', out.startsWith('<h2 id="t">見出し追加</h2>') && !out.includes('<img'), out);

  await setup(page, '<p><br></p>', 'p', 0);
  await paste(page, { 'text/html': '<b style="font-weight:normal"><p onclick="x()"><span style="font-weight:700">太字</span><img src="http://localhost:8322/images/posts/a/b.webp" onerror="y()"></p></b><script>z()</script>' });
  out = await output(page);
  check('外部HTMLを無害化し画像を相対パス化',
    out.includes('<b>太字</b>') && out.includes('src="/images/posts/a/b.webp"') && !/onclick|onerror|<script|localhost|font-weight/.test(out), out);

  await setup(page, '<p><br></p>', 'p', 0);
  await paste(page, { 'text/plain': '1行目\n\n3行目' });
  out = await output(page);
  check('複数行テキストは段落になる', out === '<p>1行目</p>\n<p><br></p>\n<p>3行目</p>\n', out);
}

async function verifyHeading(page) {
  const html = '<h2 id="h">画像の前の見出し</h2><figure class="article-image-figure"><img src="/images/none.webp" alt="" width="200" height="100"></figure><p><br></p>';
  await setup(page, html);
  await page.locator('#wysiwyg-canvas h2').click({ clickCount: 3 });
  const copied = await page.evaluate(() => {
    const transfer = new DataTransfer();
    document.getElementById('wysiwyg-canvas').dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
    return { html: transfer.getData('text/html'), text: transfer.getData('text/plain') };
  });
  check('見出しの3回クリックコピーに画像が入らない',
    copied.html.startsWith('<h2') && !/img|figure/.test(copied.html) && copied.text === '画像の前の見出し', JSON.stringify(copied));
  await page.keyboard.press('Control+c');
  await page.locator('#wysiwyg-canvas > p').last().click();
  await page.keyboard.press('Control+v');
  const out = await output(page);
  check('実キー操作の見出しコピペで画像が増えない',
    (out.match(/<img/g) || []).length === 1 && (out.match(/画像の前の見出し/g) || []).length === 2, out);

  await setup(page, html);
  await page.locator('#wysiwyg-canvas h2').click({ clickCount: 3 });
  await page.keyboard.press('Control+x');
  const cut = await output(page);
  check('見出しの切り取りで後続の画像は残る', cut.includes('<img') && !cut.includes('画像の前の見出し'), cut);

  await setup(page, '<pre><code>abc</code></pre><ul><li>項目</li></ul>', 'code', -1);
  await paste(page, { 'text/plain': '\nx = 1\ny = 2' });
  const code = await output(page);
  check('コードブロックへの複数行貼付は改行を保つ', /<pre><code>abc\nx = 1\ny = 2<\/code><\/pre>/.test(code), code);

  await setup(page, '<p>題名<img src="/images/none.webp">続き</p>', 'p', 1);
  await page.keyboard.press('Control+Alt+2');
  const converted = await output(page);
  check('見出し変換は画像を取り込まず並びを保つ',
    /^<h2>題名<\/h2>\n<p><img [^>]*><\/p>\n<p>続き<\/p>\n$/.test(converted), converted);

  await setup(page, '<figure><img src="/images/none.webp"><figcaption>説明</figcaption></figure>', 'figcaption', 1);
  await page.keyboard.press('Control+Alt+2');
  check('キャプション内は見出しに変換しない', !(await output(page)).includes('<h2'));
}

async function verifyBlocks(page) {
  const html = '<h2 id="a">A</h2><p>a1</p><h3 id="c">C</h3><p>c1</p><h2 id="b">B</h2><p>b1</p>';
  const click = async (selector, ...actions) => {
    await page.locator(`#wysiwyg-canvas ${selector}`).first().hover();
    for (const action of actions) await page.locator(`#cms-block-toolbar [data-action="${action}"]`).click();
  };
  await setup(page, html);
  await click('#a', 'section', 'down');
  check('章全体の下移動', (await order(page)) === 'B,b1,A,a1,C,c1', await order(page));
  await page.keyboard.press('Control+z');
  check('移動の取り消し', (await order(page)) === 'A,a1,C,c1,B,b1', await order(page));
  await page.mouse.move(0, 0);
  await click('#b', 'section', 'up');
  check('章全体の上移動', (await order(page)) === 'B,b1,A,a1,C,c1', await order(page));
  await setup(page, html);
  await click('p', 'down');
  check('単一ブロックの下移動', (await order(page)) === 'A,C,a1,c1,B,b1', await order(page));
  await setup(page, html);
  await page.mouse.move(0, 0);
  await click('#c', 'section', 'duplicate');
  let out = await output(page);
  check('章の複製でIDが重複しない', out.includes('id="c-2"') && (await order(page)) === 'A,a1,C,c1,C,c1,B,b1', out);
  await setup(page, html);
  await page.mouse.move(0, 0);
  await click('#a', 'section', 'delete');
  check('章の削除', (await order(page)) === 'B,b1', await order(page));
  await page.keyboard.press('Control+z');
  check('削除の取り消し', (await order(page)) === 'A,a1,C,c1,B,b1', await order(page));
  await setup(page, html);
  await page.mouse.move(0, 0);
  await click('#c', 'section', 'copy');
  await page.locator('#wysiwyg-canvas > p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+v');
  out = await output(page);
  check('章のコピーと貼付', (await order(page)) === 'A,a1,C,c1,B,b1,C,c1' && out.includes('id="c-2"'), await order(page));
  await setup(page, html);
  await page.mouse.move(0, 0);
  await page.locator('#wysiwyg-canvas #a').hover();
  await page.locator('#cms-block-toolbar [data-action="drag"]').dragTo(page.locator('#wysiwyg-canvas > p').last(),
    { targetPosition: { x: 30, y: 25 } });
  check('ドラッグ移動', (await order(page)) === 'a1,C,c1,B,b1,A', await order(page));
  check('操作パネルは保存されない', !/cms-block|章全体/.test(await output(page)));
}

async function verifySave(page, base, saved) {
  await setup(page, `<p>{波括弧}</p><pre><code>\n\nif (a) { b(); }</code></pre><p><img src="data:image/png;base64,${png}"></p>`);
  saved.length = 0;
  await page.evaluate(() => window.saveArticleContent());
  const content = saved[0]?.content || '';
  check('波括弧をエスケープ', content.includes('&#123;波括弧&#125;') && !/[{}]/.test(content), content);
  check('base64画像をファイル参照へ置換', content.includes('/images/posts/') && !content.includes('data:image'), content);
  check('保存出力はビジュアル編集可能なまま', await page.evaluate((c) => !window.CmsContent.detectSourceOnly(c)
    && window.CmsContent.cleanHtml(c) === c, content), content);
  await page.evaluate(() => window.switchEditorMode('source'));
  await page.evaluate(() => window.switchEditorMode('visual'));
  await page.locator('#wysiwyg-canvas p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('Z');
  await page.locator('#tab-visual').click();
  check('表示中タブの再クリックで編集内容が消えない', (await output(page)).includes('Z'));

  await page.goto(`${base}/?editor=not-exist-article`);
  await page.waitForTimeout(800);
  saved.length = 0;
  await page.evaluate(() => window.saveArticleContent());
  check('読込失敗時は保存しない', saved.length === 0);
}

async function verifyLayout(page, base, slug) {
  for (const width of [960, 1400]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${base}/?editor=${slug}`);
    await page.waitForFunction(() => window.editorContentReady);
    await page.locator('#wysiwyg-canvas h2').first().hover();
    const box = await page.evaluate(() => {
      const rect = (id) => document.getElementById(id).getBoundingClientRect();
      const bar = rect('cms-block-toolbar');
      const area = rect('editor-drop-zone');
      const canvas = document.getElementById('wysiwyg-canvas');
      return { inside: bar.width > 0 && bar.left >= area.left && bar.right <= area.right && bar.top >= area.top,
        overflow: canvas.scrollWidth > canvas.clientWidth };
    });
    check(`幅${width}: パネルが枠内・横はみ出しなし`, box.inside && !box.overflow, JSON.stringify(box));
    await page.screenshot({ path: path.join(shotDir, `cms-editor-${width}.png`) });
  }
}

const { child, port } = await startServer();
const browser = await chromium.launch({ headless: true });
try {
  const base = `http://localhost:${port}`;
  const slugs = (await fs.readdir(path.join(siteRoot, 'src', 'articles'))).filter((f) => f.endsWith('.astro')).map((f) => f.slice(0, -6));
  await verifyWorker(check, siteRoot);
  await verifyServer(base, port, slugs);
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'ja-JP' });
  const saved = [];
  let uploads = 0;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (url.pathname === '/api/posts/save-article-content') {
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname === '/api/posts/update-meta') return route.fulfill({ json: { success: true } });
    if (url.pathname === '/api/pages/save') {
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname === '/api/posts/upload-article-image') {
      uploads += 1;
      return route.fulfill({ json: { success: true, publicUrl: `/images/posts/mock/mock-${uploads}.webp` } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('dialog', (dialog) => dialog.accept());
  await verifyArticles(page, base, slugs, saved);
  await page.goto(`${base}/?editor=x-com-deprecate`);
  await page.waitForFunction(() => window.editorContentReady);
  await verifyPaste(page);
  await verifyHeading(page);
  await verifyBlocks(page);
  await verifyPublicFeatures({ page, check, setup, paste, output });
  await verifySave(page, base, saved);
  await verifyPages({ page, check, base, saved, siteRoot });
  await verifyLayout(page, base, 'forza-horizon-6-ban');
  check('画面のJavaScriptエラーなし', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  child.kill();
}
console.log(`\n${total - failures}/${total} 成功`);
process.exit(failures ? 1 : 0);
