/* global window, document */
// 公開CMS固有の機能（囲み・表・画像操作・固定ページ・Worker）の検証。verify-cms-editor.mjs から呼ぶ。
import fs from 'node:fs/promises';
import path from 'node:path';
import worker from '../src/worker.js';
import { extractProse, replaceProse } from '../src/page-prose.js';

const count = (text, pattern) => (text.match(pattern) || []).length;

export async function verifyWorker(check, siteRoot) {
  const sample = '<Layout>\n<div class="page-prose">x</div>\n<div class="prose"><!-- </div> --><div class="a"><p>1</p></div><p>2</p></div>\n<p>後</p>\n</Layout>\n';
  check('固定ページ: 入れ子のdivまで本文として抽出', extractProse(sample) === '<!-- </div> --><div class="a"><p>1</p></div><p>2</p>', extractProse(sample));
  const swapped = replaceProse(sample, '<p>$1 $& 新</p>');
  check('固定ページ: 本文以外を保ち記号もそのまま差し替え',
    swapped === sample.replace(/<!-- <\/div>[\s\S]*<p>2<\/p>/, () => '\n<p>$1 $& 新</p>\n'), swapped);
  check('固定ページ: 閉じていない本文は差し替えない', replaceProse('<div class="prose"><div></div>', 'x') === null);
  const pagesDir = path.join(siteRoot, 'src', 'pages');
  for (const name of (await fs.readdir(pagesDir)).filter((f) => f.endsWith('.astro'))) {
    const source = await fs.readFile(path.join(pagesDir, name), 'utf8');
    const prose = extractProse(source);
    if (prose === null) continue;
    const next = replaceProse(source, prose);
    check(`固定ページ実データ: ${name} の再保存が安定`, extractProse(next) === prose && replaceProse(next, prose) === next);
  }

  const realFetch = globalThis.fetch;
  const calls = [];
  const page = '---\nimport X from "x";\n---\n<div class="prose">\n<div class="callout"><p>旧</p></div>\n<p>末尾</p>\n</div>\n</section>\n';
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    if ((options.method || 'GET') === 'PUT') return Response.json({ commit: {} });
    return Response.json({ sha: 'abc', content: Buffer.from(page).toString('base64') });
  };
  const env = { GITHUB_PAT: 'test-token', GITHUB_OWNER: 'o', GITHUB_REPO: 'r' };
  const send = async (url, { body, headers } = {}) => {
    calls.length = 0;
    const response = await worker.fetch(new Request(`https://cms.example.test${url}`, body === undefined ? { headers } : {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    }), env, {});
    return { status: response.status, headers: response.headers, calls: calls.length };
  };
  try {
    const evil = await send('/api/pages/save', { body: { slug: 'a', content: 'x' }, headers: { Origin: 'https://evil.example' } });
    check('Worker: 別サイトからの書込を拒否', evil.status === 403 && evil.calls === 0);
    const crossRead = await send('/api/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    check('Worker: 別サイトからの読込を拒否', crossRead.status === 403);
    const own = await send('/api/health', { headers: { Origin: 'https://cms.example.test' } });
    check('Worker: 自画面は許可しCORSを返さない', own.status === 200 && !own.headers.has('Access-Control-Allow-Origin'));
    for (const route of ['save-article-content', 'upload-article-image', 'upload-thumbnail', 'update-meta', 'toggle-ai', 'toggle-draft']) {
      const bad = await send(`/api/posts/${route}`, { body: { slug: '../../x', content: 'x', imageBase64: 'x' } });
      check(`Worker: 不正slugを拒否 ${route}`, bad.status === 400 && bad.calls === 0, JSON.stringify(bad.status));
    }
    const read = await send('/api/posts/article-content?slug=..%2F..%2Fpackage');
    check('Worker: 不正slugの読込を拒否', read.status === 400 && read.calls === 0);
    const good = await send('/api/posts/article-content?slug=sample-post');
    check('Worker: 正しいslugは読込可', good.status === 200 && good.calls > 0);
    for (const url of ['/images/../package.json', '/images/%2e%2e%2f%2e%2e%2fpackage.png', '/api/thumbnails/..%2F..%2Fx.png']) {
      const result = await send(url);
      check(`Worker: 画像フォルダ外の取得を拒否 ${url}`, result.status !== 200 || !calls.some((c) => c.url.includes('..')), result.status);
    }
    for (const url of ['/images/../package.json', '/package.json', '/images/a/../../x.png', '/images/a.png?ref=x']) {
      const result = await send('/api/media/delete', { body: { url } });
      check(`Worker: 画像以外の削除を拒否 ${url}`, result.status === 400 && result.calls === 0);
    }
    const saved = await send('/api/pages/save', { body: { slug: 'sample', content: '<p>新</p>', mode: 'prose' } });
    const put = calls.find((c) => c.method === 'PUT');
    const written = put ? Buffer.from(JSON.parse(put.body).content, 'base64').toString('utf8') : '';
    check('Worker: 固定ページ本文の保存で後続が崩れない',
      saved.status === 200 && written === '---\nimport X from "x";\n---\n<div class="prose">\n<p>新</p>\n</div>\n</section>\n', written);
  } finally {
    globalThis.fetch = realFetch;
  }
}

export async function verifyPublicFeatures({ page, check, setup, paste, output }) {
  const callout = '<aside class="callout callout-note"><strong class="callout-title">題</strong><p>本文</p></aside>\n<p><br></p>';
  await setup(page, callout, 'p', -1);
  await paste(page, { 'text/html': '<p>追加1</p><p>追加2</p>', 'text/plain': '追加1\n追加2' });
  let out = await output(page);
  check('囲み内の貼付で枠が分断されない', count(out, /<aside/g) === 1 && /本文追加1<br>追加2<\/p><\/aside>/.test(out), out);
  await setup(page, callout, '.callout-title', -1);
  await paste(page, { 'text/html': '<p>A</p><p>B</p>', 'text/plain': 'A\nB' });
  out = await output(page);
  check('囲みの題名への貼付は1行の文字', out.includes('<strong class="callout-title">題A B</strong>'), out);

  await setup(page, '<div class="table-wrapper"><table><tbody><tr><td>x</td></tr></tbody></table></div><p><br></p>', 'td', -1);
  await paste(page, { 'text/html': '<p>y</p><p>z</p>', 'text/plain': 'y\nz' });
  out = await output(page);
  check('表のセル内の貼付でセルが増えない', count(out, /<td/g) === 1 && out.includes('xy<br>z</td>'), out);

  const figure = '<p>前</p><figure class="article-image-figure"><img src="/images/none.webp" alt="" width="200" height="120"><figcaption>説明</figcaption></figure><p>後</p>';
  await setup(page, figure);
  await page.evaluate(() => window.bindImageClickHandlers());
  await page.locator('#wysiwyg-canvas img').click();
  out = await output(page);
  check('画像の操作ボタンと選択状態は保存しない', !/figure-action|is-selected|削除/.test(out), out);
  await page.keyboard.press('Delete');
  check('選択画像をDeleteで削除', !(await output(page)).includes('<figure'));
  await page.keyboard.press('Control+z');
  check('画像削除をCtrl+Zで戻す', (await output(page)).includes('<figure'), await output(page));
  await page.locator('#wysiwyg-canvas .fig-action-delete').evaluate((button) => button.click());
  check('取り消し後も画像の削除ボタンが動く', !(await output(page)).includes('<figure'), await output(page));

  await setup(page, '<p>##<img src="/images/none.webp"></p>', 'p', 2);
  await page.keyboard.type(' ');
  out = await output(page);
  check('行頭記号の自動変換で画像が消えない', count(out, /<img/g) === 1 && !/<h2>[^\n]*<img/.test(out), out);

  await setup(page, '<p>前後</p>', 'p', 1);
  await page.evaluate(() => { window.openTableModal(); window.confirmInsertTable(); });
  out = await output(page);
  check('表の挿入は段落を分割', /^<p>前<\/p>\n<div class="table-wrapper">[\s\S]*<\/div>\n<p>後<\/p>\n$/.test(out), out);
  await setup(page, '<p>前後</p>', 'p', 1);
  await page.evaluate(() => {
    window.openCodeModal();
    document.getElementById('code-content').value = 'a = {1}';
    window.confirmInsertCode();
  });
  out = await output(page);
  check('コードの挿入は段落を分割し波括弧を保持',
    /^<p>前<\/p>\n<pre data-language[\s\S]*a = &#123;1&#125;[\s\S]*<\/pre>\n<p>後<\/p>\n$/.test(out), out);
  await setup(page, '<p>前後</p>', 'p', 1);
  await page.evaluate(() => {
    window.selectedPickerItem = { url: '/images/none.webp', filename: 'none.webp' };
    window.savedPickerRange = window.getSelection().getRangeAt(0).cloneRange();
    window.confirmInsertPickedMedia();
  });
  out = await output(page);
  check('メディアの挿入は段落を分割', /^<p>前<\/p>\n<figure><img [^>]*><\/figure>\n<p>後<\/p>\n$/.test(out), out);

  await verifyFigureEditing({ page, check, setup, paste, output });

  let metaCalls = 0;
  const onRequest = (request) => { if (request.url().includes('/api/posts/update-meta')) metaCalls += 1; };
  const fail = (route) => route.fulfill({ status: 500, json: { error: 'テスト' } });
  page.on('request', onRequest);
  await page.route('**/api/posts/save-article-content', fail);
  await page.evaluate(() => window.publishArticleInstantly());
  await page.unroute('**/api/posts/save-article-content', fail);
  page.off('request', onRequest);
  check('保存に失敗したら公開状態を変えない', metaCalls === 0, metaCalls);
}

async function verifyFigureEditing({ page, check, setup, paste, output }) {
  const figure = (caption) => `<figure class="article-image-figure"><img src="/images/none.webp" alt="" width="200" height="120"><figcaption contenteditable="true">${caption}</figcaption></figure>`;
  const body = `<h3>見出し</h3>${figure('説明')}<p>後ろ</p>`;
  const intact = (out) => count(out, /<figcaption/g) === 1 && out.includes('<figcaption>説明</figcaption></figure>\n<p>後ろ</p>');
  const caret = async (html, selector, offset, key) => {
    await setup(page, html, selector, offset);
    await page.keyboard.press(key);
    return output(page);
  };

  await setup(page, body, 'figcaption', -1);
  await page.keyboard.press('Enter');
  await page.keyboard.type('次');
  let out = await output(page);
  check('説明欄のEnterは図の下の行へ移動', count(out, /<figcaption/g) === 1 && out.includes('</figure>\n<p>次</p>\n<p>後ろ</p>'), out);
  out = await caret(body, 'figcaption', -1, 'Enter');
  check('Enterで作った空行は入力しなければ保存しない', intact(out), out);
  out = await caret(body, 'figcaption', -1, 'Delete');
  check('説明欄末尾のDeleteで本文を結合しない', intact(out), out);
  out = await caret(body, 'figcaption', 0, 'Backspace');
  check('説明欄先頭のBackspaceで欄を壊さない', intact(out), out);
  out = await caret(body, 'p', 0, 'Backspace');
  check('図の直後の本文は説明欄へ結合しない', intact(out), out);
  out = await caret(`${figure('説明')}<p><br></p><p>後ろ</p>`, 'figure + p', 0, 'Backspace');
  check('図の直後の空行はBackspaceで削除', intact(out), out);
  await page.keyboard.press('Control+z');
  check('空行の削除はCtrl+Zで戻る', (await output(page)).includes('<p><br></p>'), await output(page));
  await setup(page, `<h3>見出し</h3>${figure('ab')}<p>後ろ</p>`, 'figcaption', -1);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  out = await page.evaluate(() => document.querySelector('#wysiwyg-canvas figcaption').innerHTML);
  check('消し切った説明欄は空に戻る', out === '', out);
  await page.keyboard.type('c');
  check('空に戻した説明欄へ続けて入力', (await output(page)).includes('<figcaption>c</figcaption>'), await output(page));

  await setup(page, body);
  await page.evaluate(() => window.bindImageClickHandlers());
  const box = await page.evaluate(() => {
    document.querySelector('#wysiwyg-canvas figure').classList.add('is-selected');
    return ['#wysiwyg-canvas figure', '#wysiwyg-canvas .figure-action-toolbar']
      .map((s) => document.querySelector(s).getBoundingClientRect().toJSON());
  });
  check('画像の操作ボタンは画像の枠内に表示', box[1].top >= box[0].top && box[1].right <= box[0].right, JSON.stringify(box));
  await page.locator('#wysiwyg-canvas img').click();
  await page.locator('#wysiwyg-canvas figcaption').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  out = await output(page);
  check('画像選択後の説明編集で画像が消えない', out.includes('<img') && out.includes('<figcaption>説</figcaption>'), out);
  await page.locator('#wysiwyg-canvas img').click();
  await page.keyboard.press('ArrowRight');
  check('カーソル移動で画像の選択を解除', await page.evaluate(() => !document.querySelector('#wysiwyg-canvas .is-selected')));

  await setup(page, '<h3>A</h3><p>本文</p><h3>B</h3>', 'p', -1);
  await paste(page, {}, ['d.png']);
  out = await output(page);
  check('見出し前の画像貼付で空行を保存しない', /<\/figure>\n<h3>B<\/h3>/.test(out) && !out.includes('data-cms'), out);
  await page.keyboard.press('Enter');
  out = await output(page);
  check('自動の行でEnterを押した空行は保存', /<\/figure>\n<p><br><\/p>\n(<p><br><\/p>\n)?<h3>B<\/h3>/.test(out), out);

  const nested = `<figure class="article-image-figure">\n${figure('')}\n<p><br></p>\n<figcaption></figcaption>\n</figure>`;
  const clean = (html, options) => page.evaluate(([h, o]) => window.CmsContent.cleanHtml(h, o), [html, options]);
  out = await clean(nested);
  check('入れ子の図を1つに修復', count(out, /<figure/g) === 1 && count(out, /<figcaption/g) === 1 && !out.includes('<p>'), out);
  out = await clean(nested.replace(/<figcaption><\/figcaption>/, '<figcaption>外側の説明</figcaption>'));
  check('入れ子の外側の説明は内側へ移す', count(out, /<figure/g) === 1 && count(out, /<figcaption/g) === 1 && out.includes('外側の説明'), out);
  out = await clean('<figure><img src="/a.png"><figcaption>一</figcaption><figcaption><br></figcaption><figcaption>二</figcaption></figure>');
  check('重複した説明欄をまとめる', out.includes('<figcaption>一<br>二</figcaption></figure>') && count(out, /<figcaption/g) === 1, out);
  const gallery = '<figure><figure><img src="/a.png"></figure><figure><img src="/b.png"></figure><figcaption>共通</figcaption></figure>\n';
  out = await clean(gallery);
  check('共通の説明を持つ複数の図は維持', out === gallery, out);
  const gaps = `<h2>A</h2><p><br></p><p><br></p>${figure('x')}<p><br></p><h3>B</h3><p><br></p><p>本文</p><p><br></p>${figure('y')}`;
  out = await clean(gaps, { closeFigureGaps: true });
  check('読込時は見出しと画像の間の空行だけを詰める',
    /<\/h2>\n<figure[\s\S]*?<\/figure>\n<h3>/.test(out) && count(out, /<p><br><\/p>/g) === 2, out);
  const plain = await clean(gaps);
  check('通常の整形では空行を維持', count(plain, /<p><br><\/p>/g) === 5, plain);
}

export async function verifyPages({ page, check, base, saved, siteRoot }) {
  const pagesDir = path.join(siteRoot, 'src', 'pages');
  for (const name of (await fs.readdir(pagesDir)).filter((f) => f.endsWith('.astro'))) {
    const slug = name.slice(0, -6);
    const raw = await fs.readFile(path.join(pagesDir, name), 'utf8');
    await page.goto(`${base}/?page=${slug}`);
    await page.waitForFunction(() => window.editorContentReady);
    saved.length = 0;
    await page.evaluate(() => window.saveArticleContent());
    const sent = saved[0] || {};
    check(`固定ページ ${slug}: タイトル未変更なら送らない`, saved.length === 1 && !('title' in sent), sent.title);
    if (extractProse(raw) === null) {
      check(`固定ページ ${slug}: 全体を原文のまま保存`, sent.mode === 'full' && sent.content === raw, sent.mode);
      continue;
    }
    const text = (html) => page.evaluate((value) => {
      const holder = document.createElement('template');
      holder.innerHTML = value;
      return holder.content.textContent.replace(/\s+/g, '');
    }, html);
    check(`固定ページ ${slug}: 本文を保って保存`,
      sent.mode === 'prose' && (await text(sent.content)) === (await text(extractProse(raw))), sent.content);
  }
}
