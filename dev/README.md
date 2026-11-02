# 开发说明

## 目录

仓库根目录是插件和主题的源码，`dev/` 是构建工具、预览页、网页版借阅室和分享服务。

| 路径 | 内容 |
| --- | --- |
| `src/js/ac/` | 卡册、年份页、借阅室等核心逻辑，插件和网页版共用 |
| `src/css/ac/` | 对应的样式，册子风格在 `albumstyles.css` |
| `plugin/src/`、`plugin/backend/` | 插件入口、设置面板、自动更新和 Lua 后端 |
| `packaging/lazy/` | 懒人包的安装和卸载脚本 |
| `options/`、`skin.json` | 早期主题版留下的文件，插件版不使用 |
| `dev/tools/` | 构建脚本和测试 |
| `dev/preview/` | 本地预览页，加载的就是正式代码 |
| `dev/viewer/` | 网页版借阅室 |
| `dev/share-server/` | 借阅用的分享服务 |

## 本机布局

工具脚本按下面的布局找文件。克隆仓库后，把根目录内容放到主题目录，`dev/` 的内容放到 `achievement_improve`：

```text
<Steam 安装目录>/
├─ achievement_improve/                  ← dev/
└─ millennium/themes/AchievementCollection/   ← 仓库根目录
```

## 常用命令

都在 `achievement_improve` 里运行：

```powershell
npm install --ignore-scripts

npm run preview                               # 预览：http://127.0.0.1:4173/preview/
npm run preview:sync                          # 从本机 Steam 同步预览数据（数据不进仓库）

node tools/build-plugin.mjs --install         # 构建并安装到本机 Steam
node tools/build-plugin.mjs --zip             # 生成插件版和发布资产
node tools/build-lazy.mjs                     # 生成懒人包
node tools/build-viewer.mjs --root --out <kevin0036.github.io 目录>   # 构建网页版
node tools/sync-repo.mjs <仓库克隆目录>        # 把本机源码同步到仓库克隆
```

本机验收时，音乐还没上线的话可以内嵌进插件：`node tools/build-plugin.mjs --install --local-music`。这种构建不会生成发布资产。

## 测试

浏览器测试用本机 Edge，需要 Playwright：把 `AC_PLAYWRIGHT_MODULE` 指向 Playwright 所在目录。

```powershell
node --test tools/test-album-styles.mjs tools/test-room-sound.mjs tools/test-page-performance.mjs
```

`test-preview.mjs` 会核对预览数据和本机 Steam 进度，需要先运行 `npm run preview:sync`。

## 不在仓库里的文件

- `dev/preview/fixtures.js`、`client-snapshot.json`、`assets/`：本机账号的预览数据，用 `npm run preview:sync` 生成。
- `dev/viewer/src/audio/reading-room.mp3`：借阅室背景音乐，版权归原作者，不适用本项目的 MIT 许可。缺少这个文件时网页版照常构建，只是没有音乐。
- `dev/vendor/millennium/`：打懒人包用的官方 Millennium 发布包，从 [Millennium Releases](https://github.com/SteamClientHomebrew/Millennium/releases) 下载。

## 发布

1. 改 `plugin/plugin.json` 的版本号。
2. `node tools/build-plugin.mjs --zip`，再 `node tools/build-lazy.mjs`。
3. `plugin/dist/release/` 里的文件和 `plugin/dist/` 下的插件 zip 一起上传到 GitHub Release。自动更新依赖 `AchievementCollection-plugin.js`、`-backend.lua`、`-showcase.js`、`-showcase.css` 这几个文件名，不要改。
4. 借阅室有改动时重新构建并部署网页版。客户端的背景音乐放在分享服务器上，部署方式见 `share-server/Caddyfile`。
