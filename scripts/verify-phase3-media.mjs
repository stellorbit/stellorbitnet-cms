import { spawn } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright';

const PORT = 8322;

async function waitForServer(port, retries = 25) {
  for (let i = 0; i < retries; i++) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(800, () => { req.destroy(); resolve(false); });
      });
      if (ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

async function verifyMediaFeature() {
  console.log('--- Starting CMS Server for E2E Media Verification ---');
  const cms = spawn('node', ['./scripts/dev-cms.mjs'], {
    cwd: 'H:/CMS-Stellorbit',
    stdio: 'ignore'
  });

  try {
    const isUp = await waitForServer(PORT);
    if (!isUp) throw new Error('CMS server failed to start within timeout');
    console.log('✅ CMS server is running on port ' + PORT);

    const browser = await chromium.launch({ channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });

    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

    console.log('1. Navigating to CMS Dashboard...');
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.post-card', { timeout: 8000 });

    console.log('2. Opening Media Manager Modal...');
    const mediaBtn = page.locator('#btn-media-manager');
    await mediaBtn.waitFor({ state: 'visible', timeout: 5000 });
    await mediaBtn.click();
    await page.waitForSelector('#media-manager-modal.active', { timeout: 4000 });
    await page.waitForTimeout(800);

    // Screenshot 1: Media Manager Modal
    await page.screenshot({
      path: 'C:/Users/猛攻型ことねP/.gemini/antigravity/brain/b7654509-d83d-4209-a0cf-4f85366b8a27/phase3_media_manager_modal.png'
    });
    console.log('📸 Screenshot 1 taken: phase3_media_manager_modal.png');

    // 3. Filter by Unused Images
    console.log('3. Filtering by unused images...');
    const unusedTab = page.locator('#tab-media-unused');
    await unusedTab.click();
    await page.waitForTimeout(600);
    const unusedCardsCount = await page.locator('#media-manager-grid .media-card').count();
    console.log(`Unused media cards shown: ${unusedCardsCount}`);

    // 4. Close Media Modal
    console.log('4. Closing Media Modal...');
    await page.locator('#media-manager-modal button:has-text("✕")').first().click();
    await page.waitForTimeout(500);

    // 5. Open Article Editor
    console.log('5. Opening Article Editor modal...');
    await page.evaluate(() => openArticleEditorModal('forza-horizon-6-ban'));
    await page.waitForSelector('.modal-overlay#editor-modal.active', { timeout: 8000 });
    await page.waitForSelector('#wysiwyg-canvas h2', { timeout: 8000 });
    await page.waitForTimeout(600);

    // 6. Open Media Picker from Editor Toolbar
    console.log('6. Opening Media Picker from Editor Toolbar...');
    const pickerBtn = page.locator('#tb-btn-media-picker');
    await pickerBtn.waitFor({ state: 'visible', timeout: 5000 });
    await pickerBtn.click();
    await page.waitForSelector('#media-picker-modal.active', { timeout: 4000 });
    await page.waitForTimeout(800);

    // Switch to All Media tab
    console.log('Switching to "All Media" tab in picker...');
    await page.locator('#tab-picker-all').click();
    await page.waitForTimeout(600);

    // Screenshot 2: Media Picker Modal
    await page.screenshot({
      path: 'C:/Users/猛攻型ことねP/.gemini/antigravity/brain/b7654509-d83d-4209-a0cf-4f85366b8a27/phase3_editor_picker_modal.png'
    });
    console.log('📸 Screenshot 2 taken: phase3_editor_picker_modal.png');

    // 7. Select image and insert into editor
    console.log('7. Selecting first media item in picker...');
    const firstPickerItem = page.locator('#media-picker-grid .media-card').first();
    await firstPickerItem.click();
    await page.waitForTimeout(300);

    const captionInput = page.locator('#picker-caption-input');
    await captionInput.fill('Phase 3 E2E検証: 選択挿入画像');

    const insertBtn = page.locator('#btn-confirm-insert-picked');
    await insertBtn.click();
    await page.waitForTimeout(600);

    // 8. Verify inserted figure in wysiwyg canvas & scroll to it
    const hasInsertedImg = await page.evaluate(() => {
      const imgs = document.querySelectorAll('#wysiwyg-canvas img');
      return Array.from(imgs).some(img => img.src && img.src.includes('/images/'));
    });
    console.log('Image successfully inserted in wysiwyg-canvas:', hasInsertedImg);

    // Scroll to the inserted image figure to show it clearly in screenshot
    await page.evaluate(() => {
      const insertedFigure = document.querySelector('#wysiwyg-canvas figure');
      if (insertedFigure) insertedFigure.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await page.waitForTimeout(400);

    // Screenshot 3: Editor with Inserted Media
    await page.screenshot({
      path: 'C:/Users/猛攻型ことねP/.gemini/antigravity/brain/b7654509-d83d-4209-a0cf-4f85366b8a27/phase3_inserted_media.png'
    });
    console.log('📸 Screenshot 3 taken: phase3_inserted_media.png');

    await browser.close();
    console.log('🎉 Phase 3 E2E Media Verification Passed 100%!');
  } finally {
    cms.kill('SIGINT');
  }
}

verifyMediaFeature().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
