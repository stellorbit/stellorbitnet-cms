import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const command = args[0] || 'dev';
const restArgs = args.slice(1);

// Rust/Cargo のバイナリパス (~/.cargo/bin) を現在の実行PATHに確実に注入
const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
const delimiter = path.delimiter;
const currentPath = process.env.PATH || '';

const env = {
  ...process.env,
  PATH: currentPath.toLowerCase().includes(cargoBin.toLowerCase())
    ? currentPath
    : `${cargoBin}${delimiter}${currentPath}`,
};

const tauriScript = path.resolve(
  'node_modules',
  '@tauri-apps',
  'cli',
  'tauri.js'
);

const child = spawn(process.execPath, [tauriScript, command, ...restArgs], {
  stdio: 'inherit',
  env,
  shell: false,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
