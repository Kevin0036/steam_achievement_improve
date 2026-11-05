/**
 * 构建插件版：把主题的卡册 JS/CSS 与插件面板打成一个单文件 bundle。
 *
 * 产物：
 *   theme/plugin/.millennium/Dist/index.js      Millennium 加载的前端
 *   theme/plugin/dist/AchievementCollection/     可直接放进 millennium/plugins/
 *   theme/plugin/dist/release/                    GitHub Release 资产（bundle + 清单）
 *
 * 用法：
 *   node tools/build-plugin.mjs                仅构建
 *   node tools/build-plugin.mjs --install      构建并写入本机 Millennium 插件目录
 *   node tools/build-plugin.mjs --zip          额外生成手动安装 zip
 *   node tools/build-plugin.mjs --notes "..."  Release 清单里的更新说明
 *   node tools/build-plugin.mjs --debug        调试版：卡包左上角多一个「动画重播」面板（入册各档、徽章翻新），
 *                                              版本号是下一个补丁号加 -debug（比线上新，不会被自动更新换掉；
 *                                              正式版发布后又比它新，能正常升级）。产物放在 .tmp/debug-plugin/，
 *                                              直接装进本机 Millennium 插件目录，不碰 plugin/ 下的发布产物
 *   node tools/build-plugin.mjs --install --local-music
 *                                              本机验收：音乐内嵌进 bundle（多约 2.9 MB），不依赖网站。
 *                                              只写入本机插件目录，不生成发布产物；验收后跑一次普通构建还原
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STEAM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..').replaceAll('\\', '/');
const THEME_DIR = `${STEAM_ROOT}/millennium/themes/AchievementCollection`;
const PLUGIN_DIR = path.join(THEME_DIR, 'plugin');
const PLUGINS_DIR = `${STEAM_ROOT}/millennium/plugins`;
const DIST_DIR = path.join(PLUGIN_DIR, 'dist');
const PACKAGE_DIR = path.join(DIST_DIR, 'AchievementCollection');
const RELEASE_DIR = path.join(DIST_DIR, 'release');

const args = process.argv.slice(2);
const install = args.includes('--install');
const makeZip = args.includes('--zip');
const localMusic = args.includes('--local-music');
const debug = args.includes('--debug');
const DEBUG_DIR = path.join(root, '.tmp', 'debug-plugin');
const notesIndex = args.indexOf('--notes');
const notes = notesIndex >= 0 ? args[notesIndex + 1] || '' : '';

function fail(message) {
    console.error(`\n[build-plugin] ${message}\n`);
    process.exit(1);
}

function readJson(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
}

function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
}

function stripLocalImports(css) {
    return css.replace(/^\s*@import\s+url\(["']?\.\/[^)]+\);\s*$/gm, '');
}

function buildCss() {
    const cssDir = path.join(THEME_DIR, 'src/css/ac');
    const files = [
        'art.css',
        'tokens.css',
        'book.css',
        'card.css',
        'yearpages.css',
        'treepage.css',
        'coveredit.css',
        'onboarding.css',
        'borrow.css',
        'roomsound.css',
        'yearfill.css',
        'albumframes.css',
        'albumstyles.css',
        'cardpack.css',
    ];
    const fontImport =
        "@import url('https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700&display=swap');\n";

    const chunks = [fontImport];
    for (const file of files) {
        const full = path.join(cssDir, file);
        if (!existsSync(full)) fail(`缺少 ${full}`);
        chunks.push(`\n/* ===== ${file} ===== */\n${stripLocalImports(readFileSync(full, 'utf8'))}`);
    }
    chunks.push(`\n/* ===== plugin ui ===== */\n${readFileSync(path.join(PLUGIN_DIR, 'src/ui.css'), 'utf8')}`);

    const output = path.join(PLUGIN_DIR, 'plugin.css');
    writeFileSync(output, chunks.join('\n'), 'utf8');
    console.log(`[css] ${path.relative(root, output)}  ${(Buffer.byteLength(chunks.join('\n')) / 1024).toFixed(1)} KB`);
}

/** 社区展柜走 Lua 的 add_browser_css/js，需要独立的 CSS 与 IIFE bundle。 */
function buildShowcaseCss() {
    const cssDir = path.join(THEME_DIR, 'src/css/ac');
    const files = ['art.css', 'tokens.css', 'showcase.css'];
    const chunks = [];
    for (const file of files) {
        const full = path.join(cssDir, file);
        if (!existsSync(full)) fail(`缺少 ${full}`);
        chunks.push(`\n/* ===== ${file} ===== */\n${stripLocalImports(readFileSync(full, 'utf8'))}`);
    }
    const output = path.join(PLUGIN_DIR, 'showcase.css');
    writeFileSync(output, chunks.join('\n'), 'utf8');
    console.log(`[showcase css] ${path.relative(root, output)}  ${(Buffer.byteLength(chunks.join('\n')) / 1024).toFixed(1)} KB`);
}

async function buildShowcaseBundle(version, outfile = path.join(PLUGIN_DIR, 'showcase.js')) {
    ensureDir(path.dirname(outfile));
    await esbuild.build({
        entryPoints: [path.join(THEME_DIR, 'src/js/ac/profile.js')],
        outfile,
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['chrome100'],
        minify: true,
        charset: 'utf8',
        legalComments: 'none',
        define: { __AC_PLUGIN_VERSION__: JSON.stringify(version), __AC_DEBUG__: JSON.stringify(debug) },
        banner: { js: `/* AchievementCollection showcase v${version} */` },
        logLevel: 'warning',
    });
    const size = statSync(outfile).size;
    console.log(`[showcase js]  ${path.relative(root, outfile)}  ${(size / 1024).toFixed(1)} KB`);
    return outfile;
}

function localMusicUrl() {
    const bytes = readFileSync(path.join(root, 'viewer/src/audio/reading-room.mp3'));
    return `data:audio/mpeg;base64,${bytes.toString('base64')}`;
}

async function buildBundle(version, outfile = path.join(PLUGIN_DIR, '.millennium/Dist/index.js')) {
    ensureDir(path.dirname(outfile));

    await esbuild.build({
        entryPoints: [path.join(PLUGIN_DIR, 'src/index.js')],
        outfile,
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['chrome100'],
        minify: true,
        charset: 'utf8',
        legalComments: 'none',
        loader: { '.css': 'text' },
        define: {
            __AC_PLUGIN_VERSION__: JSON.stringify(version),
            __AC_ROOM_MUSIC__: JSON.stringify(localMusic ? localMusicUrl() : null),
            __AC_DEBUG__: JSON.stringify(debug),
        },
        banner: { js: `/* AchievementCollection plugin v${version} */` },
        logLevel: 'warning',
    });

    const size = statSync(outfile).size;
    console.log(`[js]  ${path.relative(root, outfile)}  ${(size / 1024).toFixed(1)} KB`);
    return outfile;
}

function stagePackage() {
    rmSync(PACKAGE_DIR, { recursive: true, force: true });
    ensureDir(path.join(PACKAGE_DIR, '.millennium/Dist'));
    ensureDir(path.join(PACKAGE_DIR, 'backend'));

    copyFileSync(path.join(PLUGIN_DIR, 'plugin.json'), path.join(PACKAGE_DIR, 'plugin.json'));
    copyFileSync(path.join(PLUGIN_DIR, 'backend/main.lua'), path.join(PACKAGE_DIR, 'backend/main.lua'));
    copyFileSync(path.join(PLUGIN_DIR, '.millennium/Dist/index.js'), path.join(PACKAGE_DIR, '.millennium/Dist/index.js'));
    copyFileSync(path.join(PLUGIN_DIR, 'showcase.js'), path.join(PACKAGE_DIR, 'showcase.js'));
    copyFileSync(path.join(PLUGIN_DIR, 'showcase.css'), path.join(PACKAGE_DIR, 'showcase.css'));
    copyFileSync(path.join(PLUGIN_DIR, 'README.md'), path.join(PACKAGE_DIR, 'README.md'));
    console.log(`[dist] ${path.relative(root, PACKAGE_DIR)}`);
}

function stageRelease(bundlePath, version) {
    ensureDir(RELEASE_DIR);
    const bundleName = 'AchievementCollection-plugin.js';
    const releaseBundle = path.join(RELEASE_DIR, bundleName);
    copyFileSync(bundlePath, releaseBundle);

    const backendName = 'AchievementCollection-backend.lua';
    const releaseBackend = path.join(RELEASE_DIR, backendName);
    copyFileSync(path.join(PLUGIN_DIR, 'backend/main.lua'), releaseBackend);

    const showcaseJsName = 'AchievementCollection-showcase.js';
    const showcaseCssName = 'AchievementCollection-showcase.css';
    const releaseShowcaseJs = path.join(RELEASE_DIR, showcaseJsName);
    const releaseShowcaseCss = path.join(RELEASE_DIR, showcaseCssName);
    copyFileSync(path.join(PLUGIN_DIR, 'showcase.js'), releaseShowcaseJs);
    copyFileSync(path.join(PLUGIN_DIR, 'showcase.css'), releaseShowcaseCss);

    const content = readFileSync(releaseBundle);
    const backend = readFileSync(releaseBackend);
    const showcaseJs = readFileSync(releaseShowcaseJs);
    const showcaseCss = readFileSync(releaseShowcaseCss);
    const manifest = {
        name: 'AchievementCollection',
        version,
        file: bundleName,
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
        backend: {
            file: backendName,
            size: backend.length,
            sha256: createHash('sha256').update(backend).digest('hex'),
        },
        showcase: {
            js: {
                file: showcaseJsName,
                size: showcaseJs.length,
                sha256: createHash('sha256').update(showcaseJs).digest('hex'),
            },
            css: {
                file: showcaseCssName,
                size: showcaseCss.length,
                sha256: createHash('sha256').update(showcaseCss).digest('hex'),
            },
        },
        notes: notes || `成就收藏册插件版 v${version}`,
    };
    writeFileSync(path.join(RELEASE_DIR, 'AchievementCollection-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`[release] ${path.relative(root, RELEASE_DIR)}`);
    return manifest;
}

function installToMillennium() {
    const target = path.join(PLUGINS_DIR, 'AchievementCollection');
    ensureDir(path.join(target, '.millennium/Dist'));
    ensureDir(path.join(target, 'backend'));

    copyFileSync(path.join(PLUGIN_DIR, 'plugin.json'), path.join(target, 'plugin.json'));
    copyFileSync(path.join(PLUGIN_DIR, 'backend/main.lua'), path.join(target, 'backend/main.lua'));
    copyFileSync(path.join(PLUGIN_DIR, '.millennium/Dist/index.js'), path.join(target, '.millennium/Dist/index.js'));
    copyFileSync(path.join(PLUGIN_DIR, 'showcase.js'), path.join(target, 'showcase.js'));
    copyFileSync(path.join(PLUGIN_DIR, 'showcase.css'), path.join(target, 'showcase.css'));
    copyFileSync(path.join(PLUGIN_DIR, 'README.md'), path.join(target, 'README.md'));
    console.log(`[install] ${target}`);
}

function makeZipArchive(version) {
    const zipName = `AchievementCollection-Plugin-v${version}-Windows.zip`;
    const zipPath = path.join(DIST_DIR, zipName);
    try {
        rmSync(zipPath, { force: true });
        // 系统自带的 tar：路径是标准的正斜杠，Compress-Archive 在 PowerShell 5.1 下会写反斜杠
        execFileSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', zipPath, '-C', DIST_DIR, 'AchievementCollection'], { stdio: 'inherit' });
        console.log(`[zip] ${zipPath}`);
    } catch (err) {
        console.error(`[zip] 生成失败：${err.message}`);
    }
}

/** 下一个补丁号 + -debug：1.2.2 → 1.2.3-debug */
function debugVersion(version) {
    const [major, minor, patch] = version.replace(/-.*$/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
    return `${major}.${minor}.${patch + 1}-debug`;
}

/** 调试版：在 .tmp/debug-plugin 里拼好整个插件目录，再整体装进本机 Millennium */
async function buildDebug(version) {
    const v = debugVersion(version);
    console.log(`[build-plugin] 调试版 v${v}`);
    rmSync(DEBUG_DIR, { recursive: true, force: true });
    buildCss();
    buildShowcaseCss();
    await buildBundle(v, path.join(DEBUG_DIR, '.millennium/Dist/index.js'));
    await buildShowcaseBundle(v, path.join(DEBUG_DIR, 'showcase.js'));
    ensureDir(path.join(DEBUG_DIR, 'backend'));
    copyFileSync(path.join(PLUGIN_DIR, 'backend/main.lua'), path.join(DEBUG_DIR, 'backend/main.lua'));
    copyFileSync(path.join(PLUGIN_DIR, 'showcase.css'), path.join(DEBUG_DIR, 'showcase.css'));
    copyFileSync(path.join(PLUGIN_DIR, 'README.md'), path.join(DEBUG_DIR, 'README.md'));
    const manifest = { ...readJson(path.join(PLUGIN_DIR, 'plugin.json')), version: v };
    writeFileSync(path.join(DEBUG_DIR, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}
`, 'utf8');

    const target = path.join(PLUGINS_DIR, 'AchievementCollection');
    for (const file of ['plugin.json', 'backend/main.lua', '.millennium/Dist/index.js', 'showcase.js', 'showcase.css', 'README.md']) {
        ensureDir(path.dirname(path.join(target, file)));
        copyFileSync(path.join(DEBUG_DIR, file), path.join(target, file));
    }
    console.log(`[install] ${target}`);
    console.log(`
完成：调试版 v${v} 已装进本机，重启 Steam 生效。换回正式版：把装之前备份的插件目录拷回去（.tmp/backup-<日期>-installed-*），或重新安装正式版的 Release。`);
}

async function main() {
    if (!existsSync(path.join(PLUGIN_DIR, 'plugin.json'))) fail(`找不到插件目录：${PLUGIN_DIR}`);
    const pluginJson = readJson(path.join(PLUGIN_DIR, 'plugin.json'));
    const version = String(pluginJson.version || '').trim();
    if (!version) fail('plugin.json 缺少 version');
    if (localMusic && (!install || makeZip)) fail('--local-music 只用于本机验收：必须配合 --install，且不能和 --zip 一起用');
    if (debug) {
        if (makeZip || localMusic) fail('--debug 只装本机：不能和 --zip / --local-music 一起用');
        await buildDebug(version);
        return;
    }

    console.log(`[build-plugin] v${version}`);
    buildCss();
    buildShowcaseCss();
    const bundlePath = await buildBundle(version);
    await buildShowcaseBundle(version);
    if (localMusic) {
        // 内嵌音乐的 bundle 绝不能进发布目录：这里提前结束，不碰 dist/
        installToMillennium();
        console.log('\n完成：本机验收版已安装（音乐内嵌）。跑一次不带参数的构建可还原 plugin/ 下的产物。');
        return;
    }
    stagePackage();
    const manifest = stageRelease(bundlePath, version);
    if (install) installToMillennium();
    if (makeZip) makeZipArchive(version);

    console.log(`\n完成：bundle ${(manifest.size / 1024).toFixed(1)} KB`);
    if (!install) console.log('未写入 Millennium 插件目录；需要本机测试时加 --install。');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
