/**
 * 成就收藏册 · 预览用静态服务器
 *
 * 只做三件事：
 *   /theme/**     ->  millennium/themes/AchievementCollection/**（只读，且限制在这个目录内）
 *   /assets/** 和 /libcache/** -> appcache/librarycache/**（只读，只放行 .jpg / .png）
 *   /**        ->  achievement_improve/**
 *
 * 刻意不把整个 Steam 目录暴露出去 —— 那里面还有 userdata。
 *
 * 用法：node tools/preview-server.mjs [port]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
// AC_THEME_ROOT 指向隔离的预览副本（例如 .tmp/year-preview-theme），
// 这样尚未验收的改动不会碰到正在使用的主题目录。
const THEME = process.env.AC_THEME_ROOT
    ? path.resolve(ROOT, process.env.AC_THEME_ROOT)
    : path.join(ROOT, '..', 'millennium', 'themes', 'AchievementCollection');
const LIBCACHE = path.join(ROOT, '..', 'appcache', 'librarycache');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.mp3': 'audio/mpeg',
    '.gif': 'image/gif',
};

function resolveTarget(urlPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(urlPath.split('?')[0]);
    } catch {
        return null;
    }
    if (decoded.includes('\0')) return null;
    const within = (root, target) => {
        const rel = path.relative(root, target);
        return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    };
    const assetPrefix = ['/assets/', '/libcache/'].find(prefix => decoded.startsWith(prefix));
    if (assetPrefix) {
        // 客户端的本地封面缓存：只放行图片
        const rel = decoded.slice(assetPrefix.length);
        const target = path.resolve(LIBCACHE, rel);
        if (!within(LIBCACHE, target) || !/\.(jpg|png)$/i.test(target)) return null;
        return target;
    }
    if (decoded.startsWith('/theme/')) {
        const rel = decoded.slice('/theme/'.length);
        const target = path.resolve(THEME, rel);
        // 防路径穿越
        if (!within(THEME, target)) return null;
        return target;
    }
    const target = path.resolve(ROOT, `.${decoded}`);
    if (!within(ROOT, target)) return null;
    return target;
}

export function createPreviewServer() {
    return createServer(async (req, res) => {
        let target = resolveTarget(req.url ?? '/');
        if (!target) {
            res.writeHead(403).end('forbidden');
            return;
        }

        try {
            if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html');
            const body = await readFile(target);
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(body);
        } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`not found: ${req.url}`);
        }
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
    createPreviewServer().listen(port, '127.0.0.1', () => {
        console.log(`成就收藏册预览服务器：http://127.0.0.1:${port}/preview/`);
        console.log(`  /theme/  只读映射到 ${THEME}`);
    });
}
