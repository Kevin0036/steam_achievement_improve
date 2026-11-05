/**
 * 把本机源码同步到 GitHub 仓库的克隆。
 *
 * 本机的工作目录分在两处，都不是 git 仓库：
 *   millennium/themes/AchievementCollection  ->  仓库根目录
 *   achievement_improve                      ->  dev/
 * 这里按白名单复制，只有列出来的文件才会进仓库；本机账号的预览数据、第三方音乐、
 * 构建产物和 .tmp 都不在名单里。仓库里已有、但本机已经没有的文件会一起删除。
 *
 * 用法：node tools/sync-repo.mjs <仓库克隆目录>
 * 只改工作区并 git add，不提交、不推送。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME = path.resolve(ROOT, '..', 'millennium', 'themes', 'AchievementCollection');

const repo = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(path.join(repo, '.git'))) {
    console.error('用法：node tools/sync-repo.mjs <仓库克隆目录>');
    process.exit(1);
}

const posix = (value) => value.split(path.sep).join('/');

/** [来源根, 来源相对路径, 仓库里的目标, 排除规则] */
const MAP = [
    [THEME, 'README.md', 'README.md'],
    [THEME, 'README.en.md', 'README.en.md'],
    [THEME, 'LICENSE', 'LICENSE'],
    [THEME, '.gitignore', '.gitignore'],
    [THEME, 'skin.json', 'skin.json'],
    [THEME, 'src', 'src'],
    [THEME, 'options', 'options'],
    [THEME, 'docs', 'docs'],
    [THEME, 'packaging', 'packaging'],
    [THEME, 'plugin', 'plugin', /^plugin\/(dist\/|\.millennium\/|plugin\.css$|showcase\.(js|css)$)/],
    [ROOT, 'DEVELOPMENT.md', 'dev/README.md'],
    [ROOT, 'package.json', 'dev/package.json'],
    [ROOT, 'package-lock.json', 'dev/package-lock.json'],
    [ROOT, 'tools', 'dev/tools'],
    [ROOT, 'preview', 'dev/preview', /^preview\/(fixtures\.js$|client-snapshot\.json$|assets\/)/],
    [ROOT, 'viewer/src', 'dev/viewer/src', /\.mp3$/],
    [ROOT, 'share-server', 'dev/share-server', /(^|\/)node_modules\//],
];

function walk(dir) {
    const files = [];
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) files.push(...walk(full));
        else files.push(full);
    }
    return files;
}

const wanted = new Map();
for (const [base, relative, target, exclude] of MAP) {
    const source = path.join(base, relative);
    if (!existsSync(source)) throw new Error(`缺少 ${source}`);
    if (statSync(source).isFile()) {
        wanted.set(target, source);
        continue;
    }
    for (const file of walk(source)) {
        const rel = posix(path.relative(base, file));
        if (exclude?.test(rel)) continue;
        wanted.set(`${target}/${posix(path.relative(source, file))}`, file);
    }
}

// 最后一道闸：任何内嵌音乐的构建产物都不能进仓库
for (const [target, source] of wanted) {
    if (/\.(js|html)$/.test(target) && readFileSync(source).includes('data:audio/mpeg;base64,')) {
        const text = readFileSync(source, 'utf8');
        if (/data:audio\/mpeg;base64,[A-Za-z0-9+/]{1000}/.test(text)) throw new Error(`${target} 内嵌了音乐`);
    }
}

let copied = 0;
for (const [target, source] of wanted) {
    const destination = path.join(repo, target);
    mkdirSync(path.dirname(destination), { recursive: true });
    if (existsSync(destination) && readFileSync(destination).equals(readFileSync(source))) continue;
    copyFileSync(source, destination);
    copied += 1;
}

const tracked = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
let removed = 0;
for (const file of tracked) {
    if (wanted.has(file)) continue;
    rmSync(path.join(repo, file), { force: true });
    removed += 1;
}

execFileSync('git', ['-C', repo, 'add', '-A']);
console.log(`[sync-repo] 文件 ${wanted.size} 个：更新 ${copied}，删除 ${removed}。已 git add，未提交。`);
