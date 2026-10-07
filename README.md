# CMS-Stellorbit

stellorbit.net 向け独立記事管理 CMS（Web UI & Tauri デスクトップアプリ）

## 構成
- **CMSサーバー / API**: Node.js (`scripts/dev-cms.mjs`, ポート `8322`)
- **Web UI**: `scripts/dev-cms.html`
- **デスクトップGUI**: Tauri 2 + HTML/JS (`src-tauri`, `cms-gui`)
- **対象サイト**: `Website-Stellorbit` (`../Website-Stellorbit` または `WEBSITE_ROOT` 環境変数)

## 起動方法

### Web UI モード
```bash
pnpm start
# または
pnpm run cms
```
ブラウザで `http://localhost:8322` を開きます。

### デスクトップGUI モード (Tauri)
```bash
pnpm run cms:app
```

## テスト
```bash
pnpm run test:standalone
```

## 設定 (.env)
`.env.example` を `.env` にコピーして環境に合わせて変更可能です。
- `WEBSITE_ROOT`: Webサイト本体のパス（デフォルト: `../Website-Stellorbit`）
- `CMS_PORT`: CMSサーバーポート（デフォルト: `8322`）
