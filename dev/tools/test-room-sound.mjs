/**
 * 借阅室声音的验收：node --test tools/test-room-sound.mjs
 *
 * 听不到声音，所以测的是可测量的部分：
 *   · 拆信音效的渲染结果（确定性、电平、不爆音）
 *   · 房间 / 册子两种混音的离线渲染差异（「变丰满」是不是真的发生了）
 *   · 预览页走一遍真实流程：手势解锁、淡入、音效和动画对齐、开合册过渡、静音、卸载
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, before, after } from 'node:test';
import { createPreviewServer } from './preview-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AC_PLAYWRIGHT_MODULE ?? 'C:/Users/Kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THEME = path.join(HERE, '..', '..', 'millennium', 'themes', 'AchievementCollection');
const { renderRoomImpulse, renderRoomSfx, SFX_CUES } = await import(pathToFileURL(path.join(THEME, 'src/js/ac/roomsfx.js')).href);

let browser;
let server;
let base;

before(async () => {
    server = createPreviewServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
});

after(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
});

/* ── 合成音效 ─────────────────────────────────────────────────────────── */

test('四段音效：结果确定、不爆音、首尾干净', () => {
    const first = renderRoomSfx(48000);
    const second = renderRoomSfx(48000);
    assert.deepEqual(Object.keys(first).sort(), [...SFX_CUES].sort());
    for (const name of SFX_CUES) {
        const samples = first[name];
        assert.deepEqual(samples, second[name], `${name} 每次渲染应该完全一致`);
        assert.ok(samples.every(Number.isFinite), `${name} 不能有 NaN`);
        const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
        assert.ok(peak > 0.2 && peak <= 0.81, `${name} 峰值 ${peak}`);
        assert.ok(Math.abs(samples.at(-1)) < 1e-3, `${name} 结尾要收干净，否则会爆音`);
    }
    // 碎裂是最响的一下，纸声要明显更轻，才不会盖过音乐
    const peakOf = (samples) => samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    assert.ok(peakOf(first.break) > peakOf(first.flap) * 1.8);
    assert.ok(peakOf(first.break) > peakOf(first.slide) * 2);
});

test('音效长度能盖住对应的动画', () => {
    const cues = renderRoomSfx(44100);
    assert.ok(cues.crack.length / 44100 >= 0.24, '封蜡抖动 0.24 秒');
    assert.ok(cues.flap.length / 44100 >= 0.5, '封舌翻开 0.55 秒');
    assert.ok(cues.slide.length / 44100 >= 0.8, '信纸抽出 0.95 秒');
});

test('混响脉冲是立体声、会衰减', () => {
    const [left, right] = renderRoomImpulse(48000);
    assert.equal(left.length, right.length);
    assert.notDeepEqual(left, right);
    const energy = (samples, from, to) => samples.slice(from, to).reduce((sum, value) => sum + value * value, 0);
    assert.ok(energy(left, 0, 12000) > energy(left, 40000, 52000) * 50);
});

/* ── 两种混音的差异 ───────────────────────────────────────────────────── */

test('翻开册子后：高频、低频、声像宽度、响度都上去了', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/preview/index.html`, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
        const { BOOK_MIX, ROOM_MIX, buildRoomChain } = await import('/theme/src/js/ac/roomsound.js');
        const bytes = await (await fetch('/viewer/src/audio/reading-room.mp3')).arrayBuffer();
        const rate = 44100;
        const probe = new OfflineAudioContext(2, 1, rate);
        const decoded = await probe.decodeAudioData(bytes);
        const start = 40;
        const seconds = 12;

        async function render(mix) {
            const ctx = new OfflineAudioContext(2, rate * seconds, rate);
            const source = ctx.createBufferSource();
            source.buffer = decoded;
            buildRoomChain(ctx, source, ctx.destination, mix);
            source.start(0, start, seconds);
            return ctx.startRendering();
        }

        /** 用离线滤波量一段频带的能量；级联四级，否则低频从二阶滤波器的过渡带漏进来 */
        async function bandDb(buffer, type, frequency) {
            const ctx = new OfflineAudioContext(1, buffer.length, rate);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            let node = source;
            for (let i = 0; i < 4; i += 1) {
                const filter = ctx.createBiquadFilter();
                filter.type = type;
                filter.frequency.value = frequency;
                node.connect(filter);
                node = filter;
            }
            node.connect(ctx.destination);
            source.start();
            const out = (await ctx.startRendering()).getChannelData(0);
            let sum = 0;
            for (let i = rate; i < out.length; i += 1) sum += out[i] * out[i];
            return 10 * Math.log10(sum / (out.length - rate) + 1e-12);
        }

        function stereo(buffer) {
            const left = buffer.getChannelData(0);
            const right = buffer.getChannelData(1);
            let mid = 0;
            let side = 0;
            let peak = 0;
            for (let i = rate; i < left.length; i += 1) {
                const m = (left[i] + right[i]) / 2;
                const s = (left[i] - right[i]) / 2;
                mid += m * m;
                side += s * s;
                peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
            }
            return { sideRatio: Math.sqrt(side / mid), rms: 10 * Math.log10((mid + side) / (left.length - rate)), peak };
        }

        const measure = async (mix) => {
            const buffer = await render(mix);
            return {
                ...stereo(buffer),
                high: await bandDb(buffer, 'highpass', 4000),
                low: await bandDb(buffer, 'lowpass', 120),
            };
        };
        return { room: await measure(ROOM_MIX), book: await measure(BOOK_MIX) };
    });
    await page.close();
    console.log('混音对比', JSON.stringify(result));

    assert.ok(result.book.high - result.room.high > 18, '册子里的高频要明显打开');
    assert.ok(result.book.low - result.room.low > 3, '册子里的低频要更厚');
    assert.ok(result.book.sideRatio > result.room.sideRatio * 1.8, '声像要展开');
    assert.ok(result.book.rms > result.room.rms + 2, '整体要更响一点');
    assert.ok(result.book.peak < 1, '不能削波');
});

/* ── 真实流程 ─────────────────────────────────────────────────────────── */

const INSTRUMENT = () => {
    const state = { contexts: [], taps: [], cues: [], classes: [] };
    window.__sound = state;
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
        constructor(...args) {
            super(...args);
            state.contexts.push(this);
        }
    };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function patched(target, ...rest) {
        const result = connect.call(this, target, ...rest);
        if (target instanceof AudioDestinationNode) {
            const analyser = this.context.createAnalyser();
            analyser.fftSize = 8192;
            analyser.smoothingTimeConstant = 0;
            connect.call(this, analyser);
            state.taps.push(analyser);
        }
        return result;
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function patched(...args) {
        state.cues.push({ at: performance.now(), seconds: this.buffer?.duration ?? 0 });
        return start.apply(this, args);
    };
    state.measure = () => {
        const tap = state.taps[0];
        if (!tap) return { rms: -120, high: -120 };
        const wave = new Float32Array(tap.fftSize);
        tap.getFloatTimeDomainData(wave);
        const spectrum = new Float32Array(tap.frequencyBinCount);
        tap.getFloatFrequencyData(spectrum);
        const hz = tap.context.sampleRate / tap.fftSize;
        let power = 0;
        spectrum.forEach((db, bin) => {
            if (bin * hz > 3000) power += 10 ** (db / 10);
        });
        const rms = Math.sqrt(wave.reduce((sum, value) => sum + value * value, 0) / wave.length);
        return { rms: 20 * Math.log10(rms + 1e-9), high: 10 * Math.log10(power + 1e-12) };
    };
    /** 连量几次取平均：音乐起伏很大，单帧不可靠 */
    state.average = async () => {
        const samples = [];
        for (let i = 0; i < 16; i += 1) {
            samples.push(state.measure());
            await new Promise((resolve) => setTimeout(resolve, 120));
        }
        const mean = (key) => samples.reduce((sum, item) => sum + item[key], 0) / samples.length;
        return { rms: mean('rms'), high: mean('high') };
    };
};

test('预览页走完一封信：淡入、音效对齐、开合册、静音', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.addInitScript(INSTRUMENT);
    await page.goto(`${base}/preview/borrow.html?demo=1`, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => document.getElementById('mail')?.classList.contains('sealed') && !document.getElementById('mail').classList.contains('arrive'));
    assert.equal(await page.evaluate(() => window.__sound.contexts[0]?.state), 'suspended', '没有手势时不能出声');

    // 记录动画节点的时刻，和音效触发时刻对比
    await page.evaluate(() => {
        const log = window.__sound.classes;
        const watch = (node, names) => {
            new MutationObserver(() => {
                for (const name of names) {
                    if (node.classList.contains(name) && !log.some((item) => item.name === name)) {
                        log.push({ name, at: performance.now() });
                    }
                }
            }).observe(node, { attributes: true, attributeFilter: ['class'] });
        };
        watch(document.getElementById('seal'), ['crack', 'brk']);
        watch(document.getElementById('mail'), ['open', 'hv']);
    });

    await page.evaluate(() => {
        const ctx = window.__sound.contexts[0];
        const stamp = () => { if (ctx.state === 'running') window.__sound.unlockedAt ??= performance.now(); };
        ctx.addEventListener('statechange', stamp);
    });
    await page.click('#seal');
    await page.waitForFunction(() => document.getElementById('mail').classList.contains('hv'));
    // 无头浏览器没有声卡，音频设备启动要等；只要求解锁确实发生
    await page.waitForFunction(() => window.__sound.contexts[0].state === 'running', null, { timeout: 15000 });
    const { cues, classes, unlockAfter } = await page.evaluate(() => ({
        cues: window.__sound.cues,
        classes: window.__sound.classes,
        unlockAfter: window.__sound.unlockedAt - window.__sound.classes[0].at,
    }));
    console.log('解锁耗时', `${unlockAfter.toFixed(0)}ms`);
    assert.equal(cues.length, 4, '四段音效各响一次');
    assert.deepEqual(classes.map((item) => item.name), ['crack', 'brk', 'open', 'hv']);
    classes.forEach((item, i) => {
        const gap = Math.abs(cues[i].at - item.at);
        assert.ok(gap < 60, `${item.name} 和音效差 ${gap.toFixed(1)}ms`);
    });

    // 手势之后音乐才开始淡入：等它走完再量
    await page.waitForFunction(() => document.getElementById('mail').classList.contains('ask'));
    const inRoom = await page.evaluate(() => window.__sound.average());
    assert.ok(inRoom.rms > -60, `房间里应该听得到音乐，实测 ${inRoom.rms.toFixed(1)} dB`);

    await page.click('#letter');
    await page.waitForTimeout(800);
    await page.click('#openBookBtn');
    await page.waitForFunction(() => document.getElementById('reader').classList.contains('visible'));
    await page.waitForTimeout(2600);
    const inBook = await page.evaluate(() => window.__sound.average());
    console.log('实时电平', JSON.stringify({ inRoom, inBook }));
    assert.ok(inBook.high - inRoom.high > 12, `翻开后高频应该打开：${inRoom.high.toFixed(1)} → ${inBook.high.toFixed(1)}`);

    // 静音：淡出、暂停、记住选择
    await page.click('#soundBtn');
    await page.waitForTimeout(1100);
    const muted = await page.evaluate(() => ({
        level: window.__sound.measure().rms,
        stored: localStorage.getItem('ac:v1:room-sound'),
        pressed: document.getElementById('soundBtn').getAttribute('aria-pressed'),
    }));
    assert.ok(muted.level < -70, `静音后还有 ${muted.level} dB`);
    assert.equal(muted.stored, '0');
    assert.equal(muted.pressed, 'false');

    await page.click('#soundBtn');
    await page.waitForTimeout(2400);
    const back = await page.evaluate(() => window.__sound.average());
    assert.ok(back.rms > -60, `重新打开后应该有声音，实测 ${back.rms.toFixed(1)} dB`);

    await page.click('#closeBtn');
    await page.waitForTimeout(3200);
    const closed = await page.evaluate(() => window.__sound.average());
    assert.ok(inBook.high - closed.high > 8, `合上后应该退回房间混音：${closed.high.toFixed(1)}`);

    assert.deepEqual(errors, []);
    await page.close();
});

test('本机验收用的 data: 内嵌音乐也能进 Web Audio（不是静音）', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(INSTRUMENT);
    await page.goto(`${base}/preview/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
        const { createRoomSound } = await import('/theme/src/js/ac/roomsound.js');
        const bytes = new Uint8Array(await (await fetch('/viewer/src/audio/reading-room.mp3')).arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        window.__room = createRoomSound({ doc: document, src: `data:audio/mpeg;base64,${btoa(binary)}` });
        window.__room.enter();
    });
    await page.mouse.click(40, 12);
    await page.waitForFunction(() => window.__sound.contexts[0]?.state === 'running', null, { timeout: 15000 });
    await page.waitForTimeout(9000);
    const level = await page.evaluate(() => window.__sound.average());
    assert.ok(level.rms > -60, `实测 ${level.rms.toFixed(1)} dB`);
    await page.close();
});

test('音乐文件加载失败时：页面不报错，音效照常', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.addInitScript(INSTRUMENT);
    await page.route('**/reading-room.mp3', (route) => route.fulfill({ status: 404, body: 'nope' }));
    await page.goto(`${base}/preview/borrow.html?demo=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('mail')?.classList.contains('sealed') && !document.getElementById('mail').classList.contains('arrive'));
    await page.click('#seal');
    await page.waitForFunction(() => document.getElementById('mail').classList.contains('hv'));
    assert.equal(await page.evaluate(() => window.__sound.cues.length), 4);
    assert.deepEqual(errors, []);
    await page.close();
});

test('本年目录：点一行翻到对应的卡', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${base}/preview/cardpack.html?binding=sequential&years=1&fresh=1&atYear=2026&face=index`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ac-leaf[data-visible] .ac-yf__row');
    await page.waitForTimeout(1600);
    const row = page.locator('.ac-leaf[data-visible] button.ac-yf__row').nth(5);
    const name = (await row.locator('.ac-yf__name').textContent()).trim();
    await row.click();
    await page.waitForTimeout(500);
    const position = await page.evaluate(() => window.__book.position);
    const shown = await page.evaluate(() => window.__book.cards[window.__book.position?.index ?? -1]?.name ?? '');
    console.log('目录跳转', name, JSON.stringify(position), shown);
    const visibleCards = await page.locator('.ac-leaf[data-visible] .ac-card').allTextContents();
    assert.ok(visibleCards.join(' ').includes(name), `翻到后应该看到 ${name}`);
    assert.deepEqual(errors, []);
    await page.close();
});

test('册子风格切换后能完全还原默认外观', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${base}/preview/cardpack.html?binding=sequential&fresh=1&at=5`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ac-page__paper');
    const read = () => page.evaluate(() => getComputedStyle(document.querySelector('.ac-page__paper')).backgroundImage.slice(0, 80));
    const plain = await read();
    await page.evaluate(() => { document.getElementById('host').dataset.album = 'velvet'; });
    assert.notEqual(await read(), plain);
    await page.evaluate(() => { delete document.getElementById('host').dataset.album; });
    assert.equal(await read(), plain);
    await page.close();
});
