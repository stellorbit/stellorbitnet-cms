/* global document */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const LOCAL_SCREENSHOT_DIR = path.join(process.cwd(), 'scripts', 'screenshots');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('🚀 CMS起動下のスプラッシュ進捗テストを開始します...');
  await fs.mkdir(LOCAL_SCREENSHOT_DIR, { recursive: true });

  // CMSサーバーを起動
  console.log('📦 テスト用CMSサーバーを起動中...');
  const cmsProc = spawn('node', ['./scripts/dev-cms.mjs'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });

  // CMSがポート8322で応答するまで待機
  let ready = false;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch('http://127.0.0.1:8322/api/health');
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // wait
    }
    await sleep(400);
  }

  if (!ready) {
    cmsProc.kill();
    throw new Error('CMSサーバーが起動しませんでした。');
  }
  console.log('✅ CMSサーバー稼働中を確認');

  try {
    const splashPath = path.resolve('cms-gui/splash.html');
    const splashUrl = `file://${splashPath.replace(/\\/g, '/')}`;

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 520, height: 400 },
      locale: 'ja-JP',
    });
    const page = await context.newPage();
    page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));

    console.log(`🌐 スプラッシュ画面を開きます: ${splashUrl}`);
    await page.goto(splashUrl);

    // 進捗が進むのを待つ (45% -> 80% -> 100%)
    await page.waitForTimeout(2000);

    const percentText = await page.locator('#percentText').textContent();
    console.log('進捗確認 [パーセンテージ]:', percentText);

    // 完了表示を待つ
    await page.waitForFunction(
      () => {
        const el = document.getElementById('percentText');
        return el && el.textContent === '100%';
      },
      { timeout: 8000 }
    );

    const finalPercent = await page.locator('#percentText').textContent();
    const finalPhase = await page.locator('#phaseText').textContent();
    console.log(`🎉 最終進捗確認: ${finalPercent} - ${finalPhase}`);

    // スクリーンショット保存
    const screenshotSplashDone = path.join(
      LOCAL_SCREENSHOT_DIR,
      'splash_completed.png'
    );
    await page.screenshot({ path: screenshotSplashDone });
    console.log(
      '📸 スプラッシュ完了スクリーンショットを保存:',
      screenshotSplashDone
    );

    await browser.close();
    console.log('✨ すべての検証が成功しました。');
  } finally {
    // サーバーの停止
    if (process.platform === 'win32') {
      try {
        const { execSync } = await import('node:child_process');
        execSync(`taskkill /F /T /PID ${cmsProc.pid}`);
      } catch {
        cmsProc.kill();
      }
    } else {
      cmsProc.kill();
    }
    console.log('🛑 テスト用CMSサーバーを停止しました。');
  }
}

main().catch((err) => {
  console.error('❌ テストエラー:', err);
  process.exit(1);
});
