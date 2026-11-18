# 开发指南

安装 Node.js 24、Rust stable 和对应平台的 Tauri 构建依赖。Windows x64 构建使用 MSVC 与 Windows SDK。

```bash
npm ci
npm run tauri dev
```

构建 Windows 安装包。

```powershell
npm run tauri -- build --target x86_64-pc-windows-msvc --bundles nsis -- --locked
```

在 macOS 或 Linux 上运行 `npm run tauri -- build` 构建对应平台的安装包。

## GitHub 发布

运行 `node scripts/version.mjs set <版本>` 同步版本号，再运行 `node scripts/version.mjs check` 验证。提交源码后推送同版本的 `v*` 标签，GitHub Actions 会构建 Windows x64 安装程序并发布 SHA-256 校验清单。也可以手动运行工作流检查构建，产物保存在 Actions 中。

## 目录结构

```
src-tauri/
  src/
    commands.rs      # Tauri command 薄包装（对应 Python 版 HTTP API）
    modules/         # 已抽离到 crates/wb-switch-core（三宿主复用）
crates/
  wb-switch-core/    # 核心逻辑：account/auth_file/oauth/process/switch/session/checkin/refresh/update/config
  wb-switch-server/  # HTTP server + CLI：axum API + rust-embed 前端
src/                 # 前端：components/pages/lib（api.ts 双通道：Tauri invoke / HTTP fetch）
npm/                 # npm 包：package.json + bin + scripts/install.js
```

## 隐私注意事项

- 仓库不提交本地数据（accounts.json、认证文件、密钥、token 由 `.gitignore` 排除）
- 发布前用 `git grep` 扫描 token 模式（`ghp_`/`npm_`/`gho_` 等）
