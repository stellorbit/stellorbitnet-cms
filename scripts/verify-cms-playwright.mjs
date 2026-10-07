/* global window, document */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const ARTIFACT_DIR =
  'C:/Users/猛攻型ことねP/.gemini/antigravity-ide/brain/accf3c80-c12a-4722-b19f-1f502c45c9a6';
const LOCAL_SCREENSHOT_DIR = path.join(process.cwd(), 'scripts', 'screenshots');

async function main() {
  console.log('🚀 Playwright Chromium を起動中...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'ja-JP',
  });
  const page = await context.newPage();

  await fs.mkdir(LOCAL_SCREENSHOT_DIR, { recursive: true });

  console.log('🌐 http://localhost:8322 にアクセス中...');
  await page.goto('http://localhost:8322', { waitUntil: 'networkidle' });

  // 1. タイトルとヘッダーの検証
  const title = await page.title();
  console.log('検証1 [タイトル]:', title);
  if (!title.includes('📖記事管理CMS')) {
    throw new Error(`タイトルが期待値と異なります: ${title}`);
  }

  const brandText = await page.locator('.brand').textContent();
  console.log('検証2 [ブランド名]:', brandText?.trim());
  if (!brandText?.includes('stellorbit.net 記事管理CMS')) {
    throw new Error(`ブランド名が期待値と異なります: ${brandText}`);
  }

  // スクリーンショット1: CMSトップページ
  const screenshot1Artifact = path.join(ARTIFACT_DIR, 'cms_top_page.png');
  const screenshot1Local = path.join(LOCAL_SCREENSHOT_DIR, 'cms_top_page.png');
  await page.screenshot({ path: screenshot1Artifact, fullPage: true });
  await page.screenshot({ path: screenshot1Local, fullPage: true });
  console.log(
    '📸 CMSトップページのスクリーンショットを保存:',
    screenshot1Artifact
  );

  // 2. 記事執筆エディタ画面 (スタンドアロン/ポップアップモード) の検証
  // 最初の一覧から最初の記事のslugを取得
  const firstWriteBtn = page.locator('.btn-action-write').first();
  const slug = (await firstWriteBtn.getAttribute('data-slug')) || 'welcome';
  console.log(`🌐 記事 [${slug}] のエディタ画面を検証中...`);

  const editorUrl = `http://localhost:8322/?editor=${encodeURIComponent(slug)}`;
  await page.goto(editorUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // ツールバーボタンの存在確認
  const tbFormatSelect = page.locator('#tb-format-select');
  const tbBtnBold = page.locator('#tb-btn-bold');
  const tbBtnUnlink = page.locator('button[title*="リンク解除"]');
  const tbBtnEmbed = page.locator('button:has-text("🌐 埋め込み")');
  const tbBtnImage = page.locator('button:has-text("🖼️ 画像追加")');
  const tbBtnCaption = page.locator('button:has-text("💬 キャプション")');

  console.log('検証3 [ツールバー項目チェック]:');
  console.log(' - フォーマットセレクト:', await tbFormatSelect.isVisible());
  console.log(' - 太字ボタン:', await tbBtnBold.isVisible());
  console.log(' - リンク解除ボタン:', await tbBtnUnlink.isVisible());
  console.log(' - 埋め込みボタン:', await tbBtnEmbed.isVisible());
  console.log(' - 画像追加ボタン:', await tbBtnImage.isVisible());
  console.log(' - キャプションボタン:', await tbBtnCaption.isVisible());

  // 3. WebサイトURLのブログカード埋め込み動作テスト
  console.log('検証4 [WebサイトURLの埋め込みテスト]...');
  await page.evaluate(async () => {
    await window.insertUrlAsEmbed('https://github.com');
  });
  await page.waitForTimeout(1500);

  const blogCard = page.locator('.wysiwyg-canvas .blog-card');
  const blogCardCount = await blogCard.count();
  console.log(' - 挿入されたブログカード数:', blogCardCount);
  if (blogCardCount === 0) {
    throw new Error('ブログカードがエディタ内に挿入されていません');
  }
  const cardTitle = await page
    .locator('.wysiwyg-canvas .blog-card-title')
    .first()
    .textContent();
  console.log(' - カードタイトル:', cardTitle?.trim());

  // コンソールログを捕捉
  page.on('console', (msg) =>
    console.log('  [Browser Console]:', msg.type(), msg.text())
  );
  page.on('pageerror', (err) =>
    console.log('  [Browser PageError]:', err.message)
  );

  // 4. X (Twitter) URLの埋め込みテスト
  console.log('検証5 [X(Twitter)ポストURLの埋め込みテスト]...');
  const embedResult = await page.evaluate(async () => {
    const res = await window.insertUrlAsEmbed(
      'https://x.com/OnslaughtktnP/status/2063211567341269121'
    );
    return {
      res,
      canvasHtml: document.getElementById('wysiwyg-canvas')?.innerHTML,
      currentEditorMode: window.currentEditorMode,
    };
  });
  console.log(
    ' - insertUrlAsEmbed 結果:',
    embedResult.res,
    'currentEditorMode:',
    embedResult.currentEditorMode
  );
  console.log(
    ' - canvas内HTMLプレビュー:',
    embedResult.canvasHtml?.slice(-400)
  );
  await page.waitForTimeout(1500);

  const tweetBlock = page.locator(
    '.wysiwyg-canvas blockquote.twitter-tweet, .wysiwyg-canvas iframe[src*="twitter"], .wysiwyg-canvas .twitter-tweet'
  );
  const tweetCount = await tweetBlock.count();
  console.log(' - 挿入されたTwitter埋め込みブロック数:', tweetCount);
  if (tweetCount === 0) {
    throw new Error('Twitter埋め込みブロックがエディタ内に挿入されていません');
  }

  // 5. 実際のペースト (paste) イベントによる自動埋め込み動作テスト
  console.log('検証6 [ペーストイベントによるURL自動埋め込みテスト]...');
  await page.evaluate(() => {
    const canvas = document.getElementById('wysiwyg-canvas');
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    // clipboardData のモック
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: (format) =>
          format === 'text/plain' ? 'https://example.com' : '',
        files: [],
        items: [],
      },
    });
    canvas.dispatchEvent(pasteEvent);
  });
  await page.waitForTimeout(1500);

  const pastedCard = page.locator('.wysiwyg-canvas a[href*="example.com"]');
  const pastedCardCount = await pastedCard.count();
  console.log(' - ペーストによって挿入されたリンクカード数:', pastedCardCount);
  if (pastedCardCount === 0) {
    throw new Error('ペーストによるリンクカードの自動生成が機能していません');
  }

  // 6. クリップボードからの画像貼り付け (paste) および表示検証
  console.log('検証7 [クリップボードからの画像ペースト＆WebP表示テスト]...');
  await page.evaluate(() => {
    // 1x1 の透明PNG Base64 から File を生成
    const base64Png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const binary = atob(base64Png);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
    const blob = new Blob([array], { type: 'image/png' });
    const file = new File([blob], 'clipboard-test.png', { type: 'image/png' });

    const canvas = document.getElementById('wysiwyg-canvas');
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: () => '',
        files: [file],
        items: [
          {
            type: 'image/png',
            getAsFile: () => file,
          },
        ],
      },
    });
    canvas.dispatchEvent(pasteEvent);
  });
  await page.waitForTimeout(2000);

  // 挿入された最新画像が正常にロードされているか（naturalWidth > 0）を検証
  const lastImg = page
    .locator('.wysiwyg-canvas img[src*="clipboard-test"]')
    .last();
  await lastImg.waitFor({ state: 'attached', timeout: 5000 });
  const imgSrc = await lastImg.getAttribute('src');
  console.log(' - ペーストされた画像のsrc:', imgSrc);
  if (!imgSrc || !imgSrc.includes('/images/posts/')) {
    throw new Error(`画像srcが期待されるパスではありません: ${imgSrc}`);
  }

  let isImgLoaded = false;
  for (let i = 0; i < 20; i++) {
    isImgLoaded = await lastImg.evaluate(
      (img) => img.complete && img.naturalWidth > 0
    );
    if (isImgLoaded) break;
    await page.waitForTimeout(250);
  }
  console.log(
    ' - 画像の読み込み成功判定 (complete & naturalWidth > 0):',
    isImgLoaded ? '✅ 正常表示' : '❌ リンク切れ'
  );
  if (!isImgLoaded) {
    throw new Error(
      'ペーストした画像が正常にブラウザ上で表示されていません（404 または破損）'
    );
  }

  // テスト用一時画像のクリーンアップ
  try {
    const localImgPath = path.join(
      process.cwd(),
      'public',
      imgSrc.replace(/^\//, '')
    );
    await fs.unlink(localImgPath);
    console.log(' 🧹 テスト用一時画像をクリーンアップ:', localImgPath);
  } catch {
    // Ignore cleanup error
  }

  // 7. はみ出しチェック (overflow check)
  const isOverflowing = await page.evaluate(() => {
    const canvas = document.getElementById('wysiwyg-canvas');
    if (!canvas) return false;
    return canvas.scrollWidth > canvas.clientWidth;
  });
  console.log(
    '検証8 [はみ出し検知 (scrollWidth > clientWidth)]:',
    isOverflowing ? '❌ はみ出しあり' : '✅ 完全に枠内に収容'
  );
  if (isOverflowing) {
    throw new Error('エディタキャンバス内でコンテンツが横にはみ出しています');
  }
  // 検証9: 見出し・段落ショートカットキー (Ctrl+2, Ctrl+0) の動作テスト
  console.log('検証9 [見出し・段落ショートカットキーのテスト]...');
  await page.locator('#wysiwyg-canvas p').first().click();
  await page.keyboard.press('Control+2');
  await page.waitForTimeout(400);
  const hasH2 = await page.locator('#wysiwyg-canvas h2').count();
  console.log(
    ' - Ctrl+2 で H2 に変換されたか:',
    hasH2 > 0 ? '✅ 成功' : '❌ 失敗'
  );
  if (hasH2 === 0)
    throw new Error('Ctrl+2 による見出し2変換が動作していません');

  await page.keyboard.press('Control+0');
  await page.waitForTimeout(400);
  const formatVal = await page.locator('#tb-format-select').inputValue();
  console.log(
    ' - Ctrl+0 で段落 (p) に戻ったか:',
    formatVal === 'p' ? '✅ 成功' : '❌ 失敗'
  );
  if (formatVal !== 'p')
    throw new Error('Ctrl+0 による段落変換が動作していません');

  // スクリーンショット2: 執筆エディタ画面 (ブログカード + X埋め込み配置後)
  const screenshot2Artifact = path.join(
    ARTIFACT_DIR,
    'cms_editor_embed_test.png'
  );
  const screenshot2Local = path.join(
    LOCAL_SCREENSHOT_DIR,
    'cms_editor_embed_test.png'
  );
  await page.screenshot({ path: screenshot2Artifact, fullPage: true });
  await page.screenshot({ path: screenshot2Local, fullPage: true });
  console.log(
    '📸 エディタ画面のスクリーンショットを保存:',
    screenshot2Artifact
  );

  await browser.close();
  console.log('🎉 全てのPlaywright検証項目が正常にパスしました！');
}

main().catch((err) => {
  console.error('❌ 検証失敗:', err);
  process.exit(1);
});
