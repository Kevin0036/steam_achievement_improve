/**
 * 借阅室构建
 *
 *   viewer/src/viewer.js  + 主题的 book.js / CSS  ->  assets/viewer-<hash>.{js,css}
 *   viewer/src/index.html                         ->  index.html
 *   viewer/src/404.html                           ->  404.html
 *   viewer/src/audio/reading-room.mp3             ->  audio/reading-room.mp3
 *
 * 用法：
 *   node tools/build-viewer.mjs
 *   node tools/build-viewer.mjs --api http://127.0.0.1:8787 --debug
 *   node tools/build-viewer.mjs --root --out ../kevin0036.github.io
 *
 * 默认输出到 viewer/dist/borrow/（旧的项目 Pages 站点）；
 * --root 直接输出到 --out 的根目录，用于 kevin0036.github.io 用户站点。
 * 构建只清理/覆盖 assets、audio/reading-room.mp3、index.html、404.html、.nojekyll，
 * 不会删除目标目录里的其他文件。
 *
 * 背景音乐放在 assets 外面、文件名不带哈希：换曲目时覆盖同一个地址即可。
 * 这份只给网页版用，客户端的那份在分享服务器上（share-server/Caddyfile）。
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

function arg(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
        return process.argv[index + 1];
    }
    return fallback;
}

const DEBUG = process.argv.includes('--debug');
const ROOT_MODE = process.argv.includes('--root');
const API_BASE = String(arg('api', process.env.AC_API_BASE || 'https://ac-share.duckdns.org:8443')).replace(/\/+$/, '');
const OUT = path.resolve(ROOT, arg('out', 'viewer/dist'));
const SITE_ROOT = String(
    arg(
        'site',
        ROOT_MODE ? 'https://kevin0036.github.io/' : 'https://kevin0036.github.io/steam-achievement-album/',
    ),
).replace(/\/?$/, '/');

try {
    const url = new URL(API_BASE);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('bad protocol');
} catch {
    console.error(`API 基址不合法：${API_BASE}`);
    process.exit(1);
}

const WEB = ROOT_MODE ? OUT : path.join(OUT, 'borrow');
const ASSETS = path.join(WEB, 'assets');
const ROOM_URL = ROOT_MODE ? SITE_ROOT : `${SITE_ROOT}borrow/`;
const VIEWER_SRC = path.join(ROOT, 'viewer', 'src');
const THEME = path.join(ROOT, '..', 'millennium', 'themes', 'AchievementCollection');

function hashName(contents, ext) {
    const hash = createHash('sha256').update(contents).digest('hex').slice(0, 8);
    return `viewer-${hash}${ext}`;
}

async function extractRoomCss() {
    const html = await readFile(path.join(ROOT, 'preview', 'borrow.html'), 'utf8');
    const style = html.match(/<style>([\s\S]*?)<\/style>/);
    if (!style) throw new Error('preview/borrow.html 里找不到 <style>');
    return style[1];
}

async function buildJs() {
    const result = await build({
        entryPoints: [path.join(VIEWER_SRC, 'viewer.js')],
        bundle: true,
        format: 'esm',
        target: ['chrome110', 'safari16'],
        minify: !DEBUG,
        sourcemap: DEBUG ? 'inline' : false,
        write: false,
        legalComments: 'none',
        logLevel: 'silent',
        define: {
            __AC_API_BASE__: JSON.stringify(API_BASE),
            __AC_DEBUG__: DEBUG ? 'true' : 'false',
        },
    });
    const file = result.outputFiles[0];
    if (!file) throw new Error('JS 构建没有产物');
    const name = hashName(file.contents, '.js');
    await writeFile(path.join(ASSETS, name), file.contents);
    return name;
}

async function buildCss() {
    const roomCss = await extractRoomCss();
    const overrides = await readFile(path.join(VIEWER_SRC, 'viewer.css'), 'utf8');
    const contents = [
        '@import url("../../../millennium/themes/AchievementCollection/options/fonts/beVietnamPro.css");',
        '@import url("../../../millennium/themes/AchievementCollection/src/css/ac/cardpack.css");',
        roomCss,
        overrides,
    ].join('\n');

    const result = await build({
        stdin: {
            contents,
            resolveDir: VIEWER_SRC,
            sourcefile: 'viewer.css',
            loader: 'css',
        },
        bundle: true,
        minify: !DEBUG,
        write: false,
        outdir: WEB,
        assetNames: '[name]-[hash]',
        loader: {
            '.woff2': 'file',
            '.woff': 'file',
            '.ttf': 'file',
            '.png': 'file',
            '.jpg': 'file',
            '.jpeg': 'file',
            '.webp': 'file',
            '.svg': 'file',
        },
        logLevel: 'silent',
    });

    let cssFile = null;
    for (const file of result.outputFiles) {
        if (file.path.endsWith('.css')) {
            cssFile = file;
            continue;
        }
        await writeFile(path.join(ASSETS, path.basename(file.path)), file.contents);
    }
    if (!cssFile) throw new Error('CSS 构建没有产物');
    const name = hashName(cssFile.contents, '.css');
    await writeFile(path.join(ASSETS, name), cssFile.contents);
    return name;
}

async function buildHtml(jsName, cssName) {
    let html = await readFile(path.join(VIEWER_SRC, 'index.html'), 'utf8');
    const apiOrigin = new URL(API_BASE).origin;
    html = html
        .replaceAll('{{CSS}}', cssName)
        .replaceAll('{{JS}}', jsName)
        .replaceAll('{{API_ORIGIN}}', apiOrigin);
    if (/{{[A-Z_]+}}/.test(html)) throw new Error('index.html 还有未替换的占位符');
    await writeFile(path.join(WEB, 'index.html'), html);

    let notFound = await readFile(path.join(VIEWER_SRC, '404.html'), 'utf8');
    notFound = notFound.replaceAll('{{ROOM_URL}}', ROOM_URL);
    await writeFile(path.join(OUT, '404.html'), notFound);
}

await mkdir(ASSETS, { recursive: true });
await rm(ASSETS, { recursive: true, force: true });
await mkdir(ASSETS, { recursive: true });
// 音乐是第三方作品，不进仓库；没有这个文件时网页版照常构建，只是没有音乐
const MUSIC = path.join(VIEWER_SRC, 'audio', 'reading-room.mp3');
if (existsSync(MUSIC)) {
    await mkdir(path.join(WEB, 'audio'), { recursive: true });
    await copyFile(MUSIC, path.join(WEB, 'audio', 'reading-room.mp3'));
} else {
    console.warn('缺少 viewer/src/audio/reading-room.mp3：这次构建没有背景音乐');
}

const jsName = await buildJs();
const cssName = await buildCss();
await buildHtml(jsName, cssName);
await writeFile(path.join(OUT, '.nojekyll'), '');

console.log('借阅室构建完成');
console.log(`  输出：${WEB}`);
console.log(`  API ：${API_BASE}`);
console.log(`  模式：${DEBUG ? '调试（未压缩，带 window.__borrowRoom）' : '生产（压缩）'}${ROOT_MODE ? ' · 根路径' : ''}`);
console.log(`  ${path.relative(OUT, path.join(ASSETS, jsName))}`);
console.log(`  ${path.relative(OUT, path.join(ASSETS, cssName))}`);
