import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const scanDirs = [
  path.join(root, 'src', 'articles'),
  path.join(root, 'src', 'content', 'blog'),
  path.join(root, 'src', 'content', 'migrated-mdx'),
];
const targetExtensions = new Set(['.astro', '.md', '.mdx']);

async function collectFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return collectFiles(entryPath);
        if (entry.isFile() && targetExtensions.has(path.extname(entry.name)))
          return [entryPath];
        return [];
      })
    );
    return files.flat();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function extractImagePaths(source) {
  const scanSource = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const paths = new Set();
  for (const match of scanSource.matchAll(
    /(?:src=["']|]\()(?<path>\/images\/[^"')\s>]+)/g
  )) {
    paths.add(match.groups.path);
  }
  return [...paths];
}

async function main() {
  const files = (await Promise.all(scanDirs.map(collectFiles))).flat();
  const missing = [];

  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    for (const imagePath of extractImagePaths(source)) {
      const diskPath = path.join(root, 'public', imagePath.replace(/^\//, ''));
      try {
        await fs.access(diskPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing.push({
          file: path.relative(root, file),
          imagePath,
        });
      }
    }
  }

  if (missing.length > 0) {
    console.error('Missing image files:');
    for (const item of missing) {
      console.error(`- ${item.file}: ${item.imagePath}`);
    }
    process.exit(1);
  }

  console.log(`Checked ${files.length} files. All /images references exist.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
