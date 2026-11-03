/**
 * 重拍 README 用的截图和动图，写进 docs/images。
 *
 *   node tools/shoot-readme.mjs                 全部重拍
 *   node tools/shoot-readme.mjs albums months   只拍其中几组（albums / months / intro）
 *
 *   albums  四款册子的同一个跨页（album-*.webp）
 *   months  月份足迹：点开一个月再收回（year-months.webp，动图）
 *   intro   入册动画四段：闪电、火焰、标准、厚重（intro-*.webp）
 *
 * 跑的是预览页（npm run preview 要先开着），昵称一律显示成 Player，不带真实账号名。
 * 动图用 CDP 抓真实运行的连续帧，再交给 ffmpeg 合成动态 WebP（比 GIF 小得多，GitHub 能直接播）。
 * 需要 Playwright（AC_PLAYWRIGHT_MODULE）和 PATH 里的 ffmpeg（或 AC_FFMPEG）。
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AC_PLAYWRIGHT_MODULE ?? 'C:/Users/Kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', '..', 'millennium', 'themes', 'AchievementCollection', 'docs', 'images');
const BASE = process.env.AC_PREVIEW_URL ?? 'http://127.0.0.1:4173';
const FFMPEG = process.env.AC_FFMPEG ?? 'ffmpeg';
const only = new Set(process.argv.slice(2));
const want = (name) => only.size === 0 || only.has(name);

const ALBUMS = ['grid', 'dots', 'astral', 'velvet'];
/** 四款都拍同一个跨页：No.014 / No.015，书口两侧都有年份标签 */
const ALBUM_QUERY = 'binding=sequential&owner=Player&years=1&tabs=1&fresh=1&at=15';
/** 入册动画四段：快速通关的两种演出、标准、厚重 */
const INTROS = [
    ['intro-lightning', 'fast', 'lightning'],
    ['intro-fire', 'fast', 'fire'],
    ['intro-standard', 'standard', null],
    ['intro-heavy', 'heavy', null],
];

const browser = await chromium.launch({ channel: 'msedge', headless: true });

function ffmpeg(args) {
    execFileSync(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
}

/** 等这一屏的图都到位：截图里不能有空白封面 */
async function imagesSettled(page) {
    await page.waitForFunction(() => [...document.querySelectorAll('.ac-leaf[data-visible] img, .ac-page--base img')]
        .every((img) => img.complete), null, { timeout: 15000 });
    await page.waitForTimeout(600);
}

/** 书本连同书口标签的外框 */
const bookBox = (page) => page.evaluate(() => {
    const rects = [document.querySelector('.ac-book'), ...document.querySelectorAll('.ac-book__tab')]
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 0);
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
});

async function shootAlbums() {
    for (const album of ALBUMS) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
        await page.goto(`${BASE}/preview/cardpack.html?${ALBUM_QUERY}&album=${album}`, { waitUntil: 'load' });
        await page.waitForSelector('.ac-card');
        await page.mouse.move(2, 2);
        await imagesSettled(page);
        const folios = await page.evaluate(() => [...document.querySelectorAll('.ac-leaf[data-visible] .ac-page__folio')].map((n) => n.textContent));
        const file = path.join(OUT, `album-${album}.webp`);
        const png = path.join(tmpdir(), `ac-album-${album}.png`);
        await page.screenshot({ path: png, clip: await bookBox(page) });
        ffmpeg(['-i', png, '-vf', 'scale=900:-2:flags=lanczos', '-c:v', 'libwebp', '-quality', '86', file]);
        rmSync(png);
        console.log(`[album] ${album} · ${folios.join(' / ')} -> ${path.basename(file)}`);
        await page.close();
    }
}

/**
 * 录一段：act() 期间抓真实运行的连续帧，按真实时间间隔合成动态 WebP。
 * 开头留 lead 秒静止画面，act 结束后再录 tail 秒。
 */
async function record(page, { name, clip, width, act, lead = 0.3, tail = 0.9 }) {
    const cdp = await page.context().newCDPSession(page);
    const frames = [];
    cdp.on('Page.screencastFrame', async (frame) => {
        frames.push({ at: frame.metadata.timestamp, data: frame.data });
        await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    });
    const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio }));
    await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 92,
        everyNthFrame: 1,
        maxWidth: Math.round(view.width * view.ratio),
        maxHeight: Math.round(view.height * view.ratio),
    });
    await page.waitForTimeout(lead * 1000 + 200);
    const started = Date.now() / 1000;
    await act();
    await page.waitForTimeout(tail * 1000);
    await cdp.send('Page.stopScreencast');

    const live = frames.filter((frame) => frame.at >= started - lead);
    const dir = mkdtempSync(path.join(tmpdir(), `ac-${name}-`));
    const list = [];
    const at = (i) => path.join(dir, `${String(i).padStart(5, '0')}.jpg`).replaceAll('\\', '/');
    live.forEach((frame, i) => {
        writeFileSync(at(i), Buffer.from(frame.data, 'base64'));
        const next = live[i + 1]?.at ?? frame.at + 1.2;
        list.push(`file '${at(i)}'`, `duration ${Math.max(0.001, next - frame.at).toFixed(4)}`);
    });
    list.push(`file '${at(live.length - 1)}'`);
    writeFileSync(path.join(dir, 'list.txt'), list.join('\n'));
    // 截屏流给的分辨率不一定等于设备像素：按第一帧的实际宽度换算裁剪框
    const ffprobe = FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    const frameWidth = Number(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', at(0)]).toString().trim());
    const scale = frameWidth / view.width;
    const crop = [clip.width, clip.height, clip.x, clip.y].map((n) => Math.round(n * scale)).join(':');
    ffmpeg([
        '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
        '-vf', `crop=${crop},fps=25,scale=${width}:-2:flags=lanczos`,
        '-c:v', 'libwebp_anim', '-quality', '72', '-compression_level', '5', '-loop', '0', '-an',
        path.join(OUT, `${name}.webp`),
    ]);
    rmSync(dir, { recursive: true, force: true });
    console.log(`[clip] ${name}.webp · ${live.length} 帧 · ${(live.at(-1).at - live[0].at).toFixed(1)}s`);
}

async function shootIntro(name, tier, style) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${BASE}/preview/cardpack.html?binding=sequential&owner=Player&introSound=0`, { waitUntil: 'load' });
    await page.waitForSelector('.ac-card');
    await page.mouse.move(2, 2);
    // 先摊到这张卡落进去的那一页，等封面都加载好再录：边翻边录的话，开头几帧的卡是空白的
    await page.evaluate((t) => {
        const card = window.__introCard(t);
        window.__book.goTo(window.__book.cards.findIndex((item) => item.appid === card.appid));
    }, tier);
    await page.waitForTimeout(400);
    await imagesSettled(page);
    await record(page, {
        name,
        clip: await bookBox(page),
        width: 800,
        act: () => page.evaluate(([t, s]) => window.__demoIntro(t, s), [tier, style]),
    });
    await page.close();
}

/**
 * 月份足迹：停在格子上，点开最高产的那个月，停一会儿再收回。
 * 拍 2025 年：最高产的一月有 8 款，格子里能看到「+4」角标，点开后是满满两排
 */
async function shootMonthsClip() {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5 });
    await page.goto(`${BASE}/preview/cardpack.html?binding=sequential&owner=Player&years=1&fresh=1&atYear=2025&face=months`, { waitUntil: 'load' });
    await page.waitForSelector('.ac-card');
    await page.waitForFunction(() => document.querySelector('.ac-leaf[data-visible] .ac-yf--months'), null, { timeout: 15000 });
    await page.mouse.move(2, 2);
    await page.waitForTimeout(2500);
    await imagesSettled(page);
    const clip = await page.evaluate(() => {
        const r = document.querySelector('.ac-leaf[data-visible] .ac-yf--months').closest('.ac-page').getBoundingClientRect();
        return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
    });
    const peak = page.locator('.ac-leaf[data-visible] button.ac-yf__month[data-peak]').first();
    const box = await peak.boundingBox();
    await record(page, {
        name: 'year-months',
        clip,
        width: 700,
        lead: 1.4,
        tail: 0.8,
        act: async () => {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
            await page.waitForTimeout(500);
            await page.mouse.down();
            await page.mouse.up();
            // 展开后鼠标正好压在第一款上，会亮着悬停底色：挪到页面下方的空白处
            await page.waitForTimeout(250);
            await page.mouse.move(clip.x + clip.width / 2, clip.y + clip.height - 60, { steps: 10 });
            await page.waitForTimeout(2550);
            // 用鼠标点 × 收回：按 Esc 收回时焦点回到格子上会亮一圈键盘焦点框，演示里像出了错
            const close = await page.locator('.ac-leaf[data-visible] .ac-yf__detail-close').boundingBox();
            await page.mouse.move(close.x + close.width / 2, close.y + close.height / 2, { steps: 10 });
            await page.waitForTimeout(250);
            await page.mouse.down();
            await page.mouse.up();
            await page.waitForTimeout(300);
            await page.mouse.move(2, 2, { steps: 6 });
        },
    });
    await page.close();
}

mkdirSync(OUT, { recursive: true });
try {
    if (want('albums')) await shootAlbums();
    if (want('months')) await shootMonthsClip();
    if (want('intro')) for (const [name, tier, style] of INTROS) await shootIntro(name, tier, style);
} finally {
    await browser.close();
}
