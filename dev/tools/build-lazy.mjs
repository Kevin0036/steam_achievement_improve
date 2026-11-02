/**
 * 打 Windows 懒人包：官方 Millennium + 成就收藏册插件 + 安装脚本。
 *
 * 用法（先跑一次 build-plugin，保证 plugin/dist/AchievementCollection 是最新的）：
 *   node tools/build-plugin.mjs --zip
 *   node tools/build-lazy.mjs
 *
 * 版本号取自 plugin/plugin.json，写进 install.ps1 和 README.txt 的副本，源文件不动。
 * 官方 Millennium 压缩包放在 vendor/millennium/，不进仓库；这里只校验 SHA256、原样打包。
 * 产物：plugin/dist/release/AchievementCollection-Lazy-v<版本>-Windows.zip
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME = path.resolve(root, '..', 'millennium', 'themes', 'AchievementCollection');
const PLUGIN_DIR = path.join(THEME, 'plugin');
const PACKAGE_DIR = path.join(PLUGIN_DIR, 'dist', 'AchievementCollection');
const LAZY_SOURCE = path.join(THEME, 'packaging', 'lazy');
const VENDOR = path.join(root, 'vendor', 'millennium');
const MILLENNIUM_VERSION = '3.6.2';
const MILLENNIUM_ZIP = `millennium-v${MILLENNIUM_VERSION}-windows-x86_64.zip`;
const MILLENNIUM_SHA = `millennium-v${MILLENNIUM_VERSION}-windows-x86_64.sha256`;

function fail(message) {
    console.error(`\n[build-lazy] ${message}\n`);
    process.exit(1);
}

function sha256(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function rewrite(file, replacements) {
    let text = readFileSync(file, 'utf8');
    for (const [pattern, replacement] of replacements) {
        if (!pattern.test(text)) fail(`${path.basename(file)} 里找不到 ${pattern}`);
        text = text.replace(pattern, replacement);
    }
    writeFileSync(file, text, 'utf8');
}

const { version } = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
if (!version) fail('plugin.json 缺少 version');

const stagedManifest = path.join(PACKAGE_DIR, 'plugin.json');
if (!existsSync(stagedManifest)) fail('缺少 plugin/dist/AchievementCollection，先运行 build-plugin');
if (JSON.parse(readFileSync(stagedManifest, 'utf8')).version !== version) {
    fail('plugin/dist 里的版本和 plugin.json 不一致，先重新运行 build-plugin');
}
const stagedBundle = readFileSync(path.join(PACKAGE_DIR, '.millennium', 'Dist', 'index.js'), 'utf8');
if (stagedBundle.includes('data:audio/mpeg;base64')) fail('bundle 内嵌了音乐，这是本机验收版，不能打进懒人包');

const zipSource = path.join(VENDOR, MILLENNIUM_ZIP);
const shaSource = path.join(VENDOR, MILLENNIUM_SHA);
if (!existsSync(zipSource) || !existsSync(shaSource)) fail(`缺少 ${VENDOR} 下的官方 Millennium 压缩包`);
const expected = readFileSync(shaSource, 'utf8').trim().split(/\s+/)[0].toLowerCase();
if (sha256(zipSource) !== expected) fail('Millennium 压缩包的 SHA256 不匹配');

const name = `AchievementCollection-Lazy-v${version}-Windows`;
const stage = path.join(PLUGIN_DIR, 'dist', 'lazy', name);
rmSync(path.dirname(stage), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const file of ['Install.bat', 'Uninstall.bat', 'install.ps1', 'uninstall.ps1', 'README.txt', 'THIRD-PARTY.md', 'LICENSE-Millennium.md']) {
    copyFileSync(path.join(LAZY_SOURCE, file), path.join(stage, file));
}
copyFileSync(path.join(THEME, 'LICENSE'), path.join(stage, 'LICENSE'));
copyFileSync(zipSource, path.join(stage, MILLENNIUM_ZIP));
copyFileSync(shaSource, path.join(stage, MILLENNIUM_SHA));
cpSync(PACKAGE_DIR, path.join(stage, 'plugin', 'AchievementCollection'), { recursive: true });

rewrite(path.join(stage, 'install.ps1'), [[/\$script:PluginVersion = '[^']*'/, `$script:PluginVersion = '${version}'`]]);
rewrite(path.join(stage, 'README.txt'), [
    [/Windows 懒人包 v\S+/, `Windows 懒人包 v${version}`],
    [/- 成就收藏册插件：v\S+/, `- 成就收藏册插件：v${version}`],
]);

const output = path.join(PLUGIN_DIR, 'dist', 'release', `${name}.zip`);
mkdirSync(path.dirname(output), { recursive: true });
rmSync(output, { force: true });
// 系统自带的 tar：路径是标准的正斜杠，Compress-Archive 在 PowerShell 5.1 下会写反斜杠
execFileSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', output, '-C', path.dirname(stage), name], { stdio: 'inherit' });

console.log(`[lazy] ${output}`);
console.log(`[lazy] SHA256 ${sha256(output)}`);
