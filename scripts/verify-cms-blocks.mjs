/* global window, document */
// ブロック内の対象選択・種類変更・ID指定・追加の検証。verify-cms-editor.mjs から呼ぶ。
const count = (text, pattern) => (text.match(pattern) || []).length;
const PANEL = '#cms-block-toolbar';

export async function verifyBlockEditing({ page, check, setup, output }) {
  const target = page.locator(`${PANEL} select[aria-label="操作する見出し・段落"]`);
  const type = page.locator(`${PANEL} select[aria-label="種類"]`);
  const id = page.locator(`${PANEL} input.cms-block-field`);
  const click = (selector) => page.locator(`#wysiwyg-canvas ${selector}`).first().click({ position: { x: 6, y: 6 } });
  const typeId = async (value) => {
    await id.fill(value);
    await id.press('Enter');
  };
  const add = async (position, kind) => {
    await page.locator(`${PANEL} [data-add="${position}"]`).click();
    await page.locator(`${PANEL} [data-kind="${kind}"]`).click();
  };
  const selected = () => target.evaluate((el) => (el.selectedOptions[0] || {}).textContent);

  const body = '<h2>章題</h2>\n<p>本文<b>太字</b></p>\n<aside class="callout callout-note"><strong class="callout-title">題</strong><h3>中見出し</h3><p>中身</p></aside>\n<h2 id="next">次の章</h2>\n<p><a href="#next">次へ</a></p>';
  await setup(page, body);
  await click('h2');
  check('ブロック: クリックした見出しが対象', (await selected()) === 'H2: 章題', await selected());
  await typeId('chapter');
  check('ブロック: IDを見出しに指定', (await output(page)).includes('<h2 id="chapter">章題</h2>'), await output(page));
  await page.keyboard.press('Control+z');
  check('ブロック: ID指定をCtrl+Zで戻す', (await output(page)).includes('<h2>章題</h2>'), await output(page));

  await click('aside p');
  check('ブロック: 囲みの中の段落を選択', (await selected()) === '段落: 中身', await selected());
  const labels = await target.evaluate((el) => Array.from(el.options, (o) => o.textContent).join('|'));
  check('ブロック: 囲みの中の見出しと段落を一覧表示', labels === 'H3: 中見出し|段落: 中身', labels);
  await type.selectOption('h4');
  let out = await output(page);
  check('ブロック: 囲みの中で段落を見出しへ変換', out.includes('<h3>中見出し</h3><h4>中身</h4></aside>'), out);
  await target.selectOption({ label: 'H3: 中見出し' });
  await typeId('inner');
  out = await output(page);
  check('ブロック: 一覧で選んだ見出しにIDを指定', out.includes('<h3 id="inner">中見出し</h3><h4>中身</h4>'), out);

  await click('p');
  await typeId('lead');
  await type.selectOption('h3');
  out = await output(page);
  check('ブロック: 種類を変えてもIDと装飾を保持', out.includes('<h3 id="lead">本文<b>太字</b></h3>'), out);
  await page.keyboard.press('Control+z');
  check('ブロック: 種類変更をCtrl+Zで戻す', (await output(page)).includes('<p id="lead">本文<b>太字</b></p>'), await output(page));

  await click('p');
  await typeId('next');
  check('ブロック: 重複IDは拒否して元に戻す', (await id.inputValue()) === 'lead' && count(await output(page), /id="next"/g) === 1, await output(page));
  await typeId('a b');
  check('ブロック: 空白を含むIDは拒否', (await id.inputValue()) === 'lead', await id.inputValue());

  // 全体の確認ダイアログ処理と競合しないよう、confirmの戻り値を差し替える
  const answer = (accept) => page.evaluate((value) => { window.confirm = () => value; }, accept);
  await click('h2#next');
  await answer(true);
  await typeId('second');
  out = await output(page);
  check('ブロック: ID変更で本文内リンクも更新', out.includes('<h2 id="second">') && out.includes('href="#second"'), out);
  await click('h2#second');
  await answer(false);
  await typeId('');
  check('ブロック: リンクがあるIDの削除は取り消せる', (await output(page)).includes('<h2 id="second">'), await output(page));
  await click('h2#second');
  await typeId('third');
  await page.evaluate(() => { delete window.confirm; });
  out = await output(page);
  check('ブロック: リンク更新を断るとIDだけ変更', out.includes('<h2 id="third">') && out.includes('href="#second"'), out);

  await click('h2');
  await page.locator(`${PANEL} [data-action="section"]`).click();
  const section = await target.evaluate((el) => el.options.length);
  check('ブロック: 章全体では章内の対象を一覧表示', section === 4, section);
  await add('after', 'p');
  await page.keyboard.type('章末');
  out = await output(page);
  check('ブロック: 章全体の下へ段落を追加', /<\/aside>\n<p>章末<\/p>\n<h2 id="third">/.test(out), out);

  const two = '<p>一</p>\n<p>二</p>';
  await setup(page, two);
  await click('p');
  await add('before', 'h2');
  await page.keyboard.type('先頭');
  out = await output(page);
  check('ブロック: 上に見出しを追加', out === '<h2>先頭</h2>\n<p>一</p>\n<p>二</p>\n', out);
  for (const [kind, expected] of [
    ['ul', '<ul><li>項目</li></ul>'], ['ol', '<ol><li>項目</li></ol>'], ['quote', '<blockquote><p>項目</p></blockquote>'], ['h4', '<h4>項目</h4>'],
  ]) {
    await setup(page, two);
    await click('p');
    await add('after', kind);
    await page.keyboard.type('項目');
    out = await output(page);
    check(`ブロック: 下に${kind}を追加`, out === `<p>一</p>\n${expected}\n<p>二</p>\n`, out);
  }
  for (const kind of ['p', 'h2', 'ul', 'quote']) {
    await setup(page, two);
    await click('p');
    await add('after', kind);
    out = await output(page);
    check(`ブロック: 空のまま残した${kind}は保存しない`, out === '<p>一</p>\n<p>二</p>\n', out);
  }
  await page.keyboard.press('Control+z');
  check('ブロック: 追加をCtrl+Zで戻す', (await page.locator('#wysiwyg-canvas > *').count()) === 2);

  for (const [kind, modal, confirm, pattern] of [
    ['table', 'table-modal', () => window.confirmInsertTable(), /^<p>一<\/p>\n<div class="table-wrapper">[\s\S]*<\/div>\n<p>二<\/p>\n$/],
    ['code', 'code-modal', () => window.confirmInsertCode(), /^<p>一<\/p>\n<pre [\s\S]*<\/pre>\n<p>二<\/p>\n$/],
    ['callout', 'callout-modal', () => window.confirmInsertCallout(), /^<p>一<\/p>\n<(aside|blockquote)[\s\S]*<\/(aside|blockquote)>\n<p>二<\/p>\n$/],
  ]) {
    await setup(page, two);
    await click('p');
    await add('after', kind);
    const open = await page.evaluate((name) => document.getElementById(name).classList.contains('active'), modal);
    await page.evaluate(confirm);
    out = await output(page);
    check(`ブロック: ${kind}の挿入画面を開き指定位置へ挿入`, open && pattern.test(out), out);
  }
  for (const [kind, modal, close] of [
    ['media', 'media-picker-modal', () => window.closeMediaPickerModal()], ['embed', 'embed-modal', () => window.closeEmbedModal()],
  ]) {
    await setup(page, two);
    await click('p');
    await add('after', kind);
    await page.waitForFunction((name) => document.getElementById(name).classList.contains('active'), modal);
    await page.evaluate(close);
    check(`ブロック: ${kind}を開いて閉じても空行は保存しない`, (await output(page)) === '<p>一</p>\n<p>二</p>\n', await output(page));
  }
  await setup(page, two);
  await click('p');
  const chooser = page.waitForEvent('filechooser');
  await add('after', 'image');
  await (await chooser).setFiles({
    name: 'added.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
  });
  await page.waitForFunction(() => document.querySelector('#wysiwyg-canvas figure'));
  out = await output(page);
  check('ブロック: 画像を指定位置へ追加', /^<p>一<\/p>\n<figure[\s\S]*<\/figure>\n<p>二<\/p>\n$/.test(out), out);

  await setup(page, '<figure><img src="/images/none.webp" width="200" height="120"><figcaption>説明</figcaption></figure>\n<p>後</p>');
  await page.locator('#wysiwyg-canvas img').hover();
  check('ブロック: 画像ブロックは追加のみ表示',
    (await target.isHidden()) && (await id.isHidden()) && (await page.locator(`${PANEL} [data-add="after"]`).isVisible()));

  await setup(page, '<h2>固定</h2>\n<p>あ</p>\n<p>い</p>\n<p>う</p>');
  await click('h2');
  await id.click();
  await page.keyboard.type('ke');
  await page.locator('#wysiwyg-canvas p').last().hover();
  await page.evaluate(() => {
    document.getElementById('wysiwyg-canvas').dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
  });
  await page.keyboard.type('ep');
  await page.keyboard.press('Enter');
  check('ブロック: ID入力中は対象を切り替えない', (await output(page)).startsWith('<h2 id="keep">固定</h2>'), await output(page));

  await setup(page, '<h2>上部</h2>\n<p>下の段落</p>');
  await click('p');
  await page.locator('#tb-heading-id').click();
  await page.keyboard.type('from-top');
  await page.keyboard.press('Enter');
  out = await output(page);
  check('ブロック: 上部ID欄が段落に反映', out.includes('<p id="from-top">下の段落</p>'), out);
  await click('h2');
  await page.locator('#tb-heading-id').fill('top-heading');
  await click('p');
  out = await output(page);
  check('ブロック: 上部ID欄は欄を離れる時に元の対象へ反映', out.includes('<h2 id="top-heading">上部</h2>'), out);

  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, '<h2>狭い画面の長い見出しの確認用テキスト</h2>\n<p>本文</p>');
  await click('p');
  await page.locator(`${PANEL} [data-add="after"]`).click();
  const boxes = await page.evaluate(() => ['#cms-block-toolbar', '.cms-block-menu']
    .map((s) => document.querySelector(s).getBoundingClientRect().toJSON()));
  check('ブロック: 390px幅でパネルとメニューが画面内', boxes.every((b) => b.left >= 0 && b.right <= 390), JSON.stringify(boxes));
  await page.keyboard.press('Escape');
  check('ブロック: Escapeで追加メニューを閉じる', await page.locator('.cms-block-menu').isHidden());
  await page.setViewportSize(size);
}
