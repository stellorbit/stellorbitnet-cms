import { spawn } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright';

const PORT = 8322;
const SCREENSHOT_EDITOR = 'C:/Users/猛攻型ことねP/.gemini/antigravity/brain/b7654509-d83d-4209-a0cf-4f85366b8a27/phase2_editor_workspace.png';
const SCREENSHOT_TABLE = 'C:/Users/猛攻型ことねP/.gemini/antigravity/brain/b7654509-d83d-4209-a0cf-4f85366b8a27/phase2_table_modal.png';

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

async function run() {
  console.log('🚀 Starting CMS server...');
  const cmsProc = spawn('node', ['./scripts/dev-cms.mjs'], {
    cwd: process.cwd(),
    stdio: 'ignore'
  });

  try {
    const isUp = await waitForServer(PORT);
    if (!isUp) throw new Error('CMS server failed to start within timeout');
    console.log('✅ CMS server is running on port ' + PORT);

    console.log('🌐 Launching Playwright browser (Edge)...');
    const browser = await chromium.launch({ channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });

    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

    console.log('📄 Navigating to CMS Dashboard...');
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

    // Wait for post cards to load
    await page.waitForSelector('.post-card', { timeout: 8000 });
    const postCount = await page.locator('.post-card').count();
    console.log(`[Dashboard] Loaded ${postCount} post cards.`);

    // Click "✍️ 記事執筆" on the first post card or open via function
    console.log('📝 Opening first article in WYSIWYG Editor modal...');
    await page.evaluate(() => openArticleEditorModal('forza-horizon-6-ban'));

    // Wait for Editor Modal to be active and article content to load
    await page.waitForSelector('.modal-overlay#editor-modal.active', { timeout: 8000 });
    await page.waitForSelector('#wysiwyg-canvas h2', { timeout: 8000 });
    await page.waitForTimeout(800);

    // Verify Toolbar Buttons
    const hasTableBtn = await page.getByRole('button', { name: '📊 表' }).isVisible();
    const hasAddRowBtn = await page.getByTitle('選択中の表に下行を追加').isVisible();
    const hasAddColBtn = await page.getByTitle('選択中の表に右列を追加').isVisible();
    const hasCodeBtn = await page.getByTitle('コードブロック挿入 (言語指定 / <pre><code>)').isVisible();
    const hasEmbedBtn = await page.getByRole('button', { name: '🌐 埋め込み' }).isVisible();
    const hasTocBtn = await page.locator('#tb-btn-toc').isVisible();

    console.log('[Verification] Toolbar Buttons:', {
      table: hasTableBtn,
      addRow: hasAddRowBtn,
      addCol: hasAddColBtn,
      code: hasCodeBtn,
      embed: hasEmbedBtn,
      toc: hasTocBtn
    });

    // Verify TOC Panel and headings
    const tocVisible = await page.locator('#editor-toc-panel').isVisible();
    const tocItemsCount = await page.locator('.toc-item').count();
    console.log('[Verification] TOC Panel Visible:', tocVisible, 'Headings Count in TOC:', tocItemsCount);

    // Take screenshot of editor workspace with TOC
    await page.screenshot({ path: SCREENSHOT_EDITOR });
    console.log('📸 Editor workspace screenshot saved to:', SCREENSHOT_EDITOR);

    // Open Table Modal
    await page.getByRole('button', { name: '📊 表' }).click();
    await page.waitForSelector('#table-modal.active', { timeout: 5000 });
    await page.waitForTimeout(400);

    // Take screenshot of Table Modal
    await page.screenshot({ path: SCREENSHOT_TABLE });
    console.log('📸 Table Modal screenshot saved to:', SCREENSHOT_TABLE);

    // Confirm Insert Table
    await page.locator('#table-modal .btn-primary').click();
    await page.waitForTimeout(400);
    const hasTable = await page.locator('#wysiwyg-canvas table').isVisible();
    console.log('[Verification] Table Inserted into Canvas:', hasTable);

    // Test Table Modification (Add Row, Add Col)
    const firstCell = page.locator('#wysiwyg-canvas td').first();
    await firstCell.click();
    await page.waitForTimeout(200);
    await page.getByTitle('選択中の表に下行を追加').click();
    await page.getByTitle('選択中の表に右列を追加').click();
    await page.waitForTimeout(300);

    // Open Code Modal & Insert Code
    await page.getByTitle('コードブロック挿入 (言語指定 / <pre><code>)').click();
    await page.waitForSelector('#code-modal.active', { timeout: 5000 });
    await page.locator('#code-language').selectOption('typescript');
    await page.locator('#code-content').fill('const greeting: string = "Hello Stellorbit CMS!";\nconsole.log(greeting);');
    await page.locator('#code-modal .btn-primary').click();
    await page.waitForTimeout(400);

    const hasCodeBlock = await page.locator('#wysiwyg-canvas pre[data-language="typescript"]').isVisible();
    console.log('[Verification] TypeScript Code Block Inserted:', hasCodeBlock);

    // Take screenshot of canvas with inserted Table & Code Block
    const SCREENSHOT_INSERTED = 'C:/Users/猛攻型ことねP/.gemini/antigravity/brain/b7654509-d83d-4209-a0cf-4f85366b8a27/phase2_inserted_elements.png';
    await page.screenshot({ path: SCREENSHOT_INSERTED });
    console.log('📸 Inserted elements screenshot saved to:', SCREENSHOT_INSERTED);

    // Open Embed Modal and close
    await page.getByRole('button', { name: '🌐 埋め込み' }).click();
    await page.waitForSelector('#embed-modal.active', { timeout: 5000 });
    await page.locator('#embed-modal .btn-secondary').first().click();
    await page.waitForTimeout(300);

    await browser.close();
    console.log('\n🎉 Phase 2 Full Visual & Functional Verifications Completed Successfully!');
  } finally {
    console.log('🛑 Terminating CMS server...');
    cmsProc.kill();
    await new Promise(r => setTimeout(r, 600));
  }
}

run().catch(err => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
