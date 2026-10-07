import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const root = process.cwd();

// 事前ビルドされた実行ファイル候補（Release版優先、次にDebug版）
const candidates = [
  path.join(root, 'src-tauri', 'target', 'release', 'stellorbit-cms.exe'),
  path.join(root, 'src-tauri', 'target', 'release', 'app.exe'),
  path.join(root, 'src-tauri', 'target', 'debug', 'app.exe'),
];

const targetExe = candidates.find((p) => fs.existsSync(p));

if (!targetExe) {
  console.log(
    '⚡ 実行ファイルが見つかりません。事前ビルドを実行して起動します...'
  );
  const buildProc = spawn(
    process.execPath,
    [path.join(root, 'scripts', 'run-tauri.mjs'), 'dev'],
    {
      stdio: 'inherit',
      cwd: root,
    }
  );
  buildProc.on('exit', (code) => process.exit(code ?? 0));
} else {
  console.log(
    `\n🚀 事前ビルド済みCMSアプリを即時起動します (ビルド待ち時間: 0秒)\n実行ファイル: ${path.relative(root, targetExe)}\n`
  );
  const child = spawn(targetExe, [], {
    stdio: 'inherit',
    cwd: root,
    detached: false,
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}
