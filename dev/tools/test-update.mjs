/**
 * 自动更新的回归测试，三层：
 *   · 版本比较、提醒结论、更新说明的纯逻辑；
 *   · 浏览器里跑真实的 update.js，模拟超时、反复进入、关弹窗和已安装；
 *   · 用真实的 Lua 解释器跑 main.lua 的 InstallUpdate，文件系统是内存假的，可以注入失败。
 *
 * 后两层依赖本机环境，缺了就跳过：
 *   AC_PLAYWRIGHT_MODULE  Playwright 所在目录
 *   AC_WASMOON_MODULE     wasmoon 所在目录（Lua 解释器，npm i wasmoon 到仓库外任意目录）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THEME = path.join(HERE, '..', '..', 'millennium', 'themes', 'AchievementCollection');
const BASE = process.env.AC_PREVIEW_URL ?? 'http://127.0.0.1:4173';
const { decideUpdate, isNewerVersion, releaseNotesText } = await import(
    pathToFileURL(path.join(THEME, 'plugin', 'src', 'updatelogic.js')).href
);

function load(envName, name) {
    const dir = process.env[envName];
    if (!dir) return null;
    return createRequire(path.join(dir, 'package.json'))(name);
}

/* ── 纯逻辑 ─────────────────────────────────────────────────────────────── */

test('版本比较：正常升级、内测转正式、认不出来的版本', () => {
    const cases = [
        ['1.2.2', '1.2.1', true],
        ['v1.2.10', '1.2.9', true],
        ['1.2.1', '1.2.1', false],
        ['1.2.0', '1.2.1', false],
        ['1.3', '1.2.9', true],
        ['1.2.0', '1.2.0-beta', true],
        ['1.2.0-beta', '1.2.0', false],
        ['1.2.1-beta', '1.2.0', true],
        ['1.2.0-beta', '1.2.0-beta', false],
        ['unknown', '1.2.0', false],
        ['1.2.0', 'dev', false],
    ];
    for (const [candidate, current, expected] of cases) {
        assert.equal(isNewerVersion(candidate, current), expected, `${candidate} vs ${current}`);
    }
});

test('提醒结论：看的是磁盘上的版本，不是留在本机的记录', () => {
    const base = { latest: '1.2.2', running: '1.2.1' };
    assert.equal(decideUpdate({ latest: '1.2.1', running: '1.2.1' }), 'latest');
    assert.equal(decideUpdate(base), 'update');
    assert.equal(decideUpdate({ ...base, onDisk: '1.2.1' }), 'update');
    // 文件已经是新版，这次 Steam 还在跑旧代码
    assert.equal(decideUpdate({ ...base, onDisk: '1.2.2' }), 'restart');
    assert.equal(decideUpdate({ ...base, installed: '1.2.2' }), 'restart');
    // 装好 1.2.2 还没重启，1.2.3 又发布了：应该继续提示更新
    assert.equal(decideUpdate({ latest: '1.2.3', running: '1.2.1', onDisk: '1.2.2' }), 'update');
    // 后端读不到版本时不能误判成「等待重启」
    assert.equal(decideUpdate({ ...base, onDisk: 'unknown' }), 'update');
    assert.equal(decideUpdate({ ...base, skipped: '1.2.2' }), 'skipped');
    assert.equal(decideUpdate({ ...base, skipped: '1.2.2', manual: true }), 'update');
    assert.equal(decideUpdate({ ...base, skipped: '1.2.1' }), 'update');
});

test('更新说明：只留这一版的内容，不留懒人包说明和 Markdown 记号', () => {
    const body = [
        '## 懒人包（第一次安装看这里）',
        '**[Lazy.zip](https://example.com/a.zip)**（约 4 MB）',
        '- 解压后双击 `Install.bat`',
        '',
        '## v1.2.1 更新内容',
        '',
        '### 全新的卡片边框',
        '',
        '- **方格黑卡**：集邮册式的双线印刷框。',
        '- 看 [说明](https://example.com) ![图](https://example.com/a.png)',
        '',
        '## 校验',
        'sha256 abc',
    ].join('\r\n');
    assert.equal(releaseNotesText(body), '全新的卡片边框\n\n· 方格黑卡：集邮册式的双线印刷框。\n· 看 说明');
    assert.equal(releaseNotesText('修了几个问题'), '修了几个问题');
    assert.equal(releaseNotesText(null), '');
});

/* ── 真实的 update.js ───────────────────────────────────────────────────── */

const playwright = load('AC_PLAYWRIGHT_MODULE', 'playwright');

async function withBrowser(run) {
    const browser = await playwright.chromium.launch({ ...(process.env.AC_CHROMIUM ? { executablePath: process.env.AC_CHROMIUM } : { channel: 'msedge' }), headless: true });
    try {
        await run(browser);
    } finally {
        await browser.close();
    }
}

/** 打开预览并放进一个可控的后端。script 在 update.js 加载之前运行 */
async function openDemo(browser, { running = '1.2.1', onDisk = '1.2.1', failFirst = 0 } = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.addInitScript(({ running: version, onDisk: disk, failFirst: failures }) => {
        window.__AC_PLUGIN_VERSION__ = version;
        window.__calls = { FetchRelease: 0, InstallUpdate: 0 };
        window.__disk = disk;
        let failing = failures;
        window.Millennium = {
            callServerMethod: async (plugin, method) => {
                window.__calls[method] = (window.__calls[method] ?? 0) + 1;
                if (method === 'InstallUpdate') {
                    window.__disk = '1.2.2';
                    return JSON.stringify({ success: true, version: '1.2.2' });
                }
                if (failing > 0) {
                    failing -= 1;
                    return JSON.stringify({ success: false, error: 'Timeout was reached', current: window.__disk });
                }
                return JSON.stringify({ success: true, current: window.__disk, raw: JSON.stringify(window.__demoRelease) });
            },
        };
    }, { running, onDisk, failFirst });
    // 后端失败时会退回浏览器 fetch，这里让它也失败，才等于真的断网
    await page.route('https://api.github.com/**', (route) => route.abort());
    await page.goto(`${BASE}/preview/cardpack.html?binding=sequential&owner=Player&updateDemo=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ac-card');
    return page;
}

const enter = async (page) => {
    await page.evaluate(() => window.__enterCardPack());
    await page.waitForTimeout(1500);
};
const pill = (page) => page.locator('.ac-update-open');
const dialog = (page) => page.locator('.ac-update');

test('一次超时不会让这次 Steam 运行期间再也查不了', { skip: !playwright }, () => withBrowser(async (browser) => {
    const page = await openDemo(browser, { failFirst: 1 });
    await page.waitForTimeout(1600);
    assert.equal(await page.evaluate(() => window.__calls.FetchRelease), 1);
    assert.equal(await dialog(page).count(), 0);
    await enter(page);
    assert.equal(await page.evaluate(() => window.__calls.FetchRelease), 2);
    assert.equal(await dialog(page).count(), 1);
}));

test('每次进入都查，五分钟内反复进出用上次的结果', { skip: !playwright }, () => withBrowser(async (browser) => {
    const page = await openDemo(browser);
    await dialog(page).waitFor();
    await page.locator('.ac-update .ac-export__x').click();
    await enter(page);
    await enter(page);
    assert.equal(await page.evaluate(() => window.__calls.FetchRelease), 1);
    await page.evaluate(() => {
        const realNow = Date.now.bind(Date);
        Date.now = () => realNow() + 6 * 60 * 1000;
    });
    await enter(page);
    assert.equal(await page.evaluate(() => window.__calls.FetchRelease), 2);
}));

test('关掉弹窗：这次运行不再弹，提醒还在，重启后再弹', { skip: !playwright }, () => withBrowser(async (browser) => {
    const page = await openDemo(browser);
    await dialog(page).waitFor();
    assert.equal(await pill(page).textContent(), '新版本 v1.2.2');
    await page.locator('.ac-update .ac-export__x').click();
    await enter(page);
    assert.equal(await dialog(page).count(), 0);
    assert.equal(await pill(page).isVisible(), true);
    await pill(page).click();
    assert.equal(await dialog(page).count(), 1);
    await page.locator('.ac-update .ac-export__x').click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dialog(page).waitFor();
}));

test('暂不更新：重启也不再弹窗，但每次进入都能看到提醒', { skip: !playwright }, () => withBrowser(async (browser) => {
    const page = await openDemo(browser);
    await dialog(page).waitFor();
    await page.getByRole('button', { name: '暂不更新' }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await pill(page).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await dialog(page).count(), 0);
    await pill(page).click();
    assert.equal(await dialog(page).count(), 1);
}));

test('弹窗里的说明是这一版的内容，不是懒人包说明', { skip: !playwright }, () => withBrowser(async (browser) => {
    const page = await openDemo(browser);
    await dialog(page).waitFor();
    const notes = await page.locator('.ac-update__notes').textContent();
    assert.match(notes, /聚光灯引导/);
    assert.doesNotMatch(notes, /懒人包|sha256|\*\*|##/);
}));

test('装好以后提醒变成等待重启，不再弹窗', { skip: !playwright }, () => withBrowser(async (browser) => {
    const page = await openDemo(browser);
    await dialog(page).waitFor();
    await page.getByRole('button', { name: '自动更新' }).click();
    await page.locator('.ac-update__status.is-ok').waitFor();
    await page.getByRole('button', { name: '完成' }).click();
    assert.equal(await pill(page).textContent(), '重启 Steam 完成更新');
    assert.equal(await pill(page).isDisabled(), true);
    await enter(page);
    assert.equal(await dialog(page).count(), 0);
}));

test('磁盘上已经是新版：重开界面后不再提示安装', { skip: !playwright }, () => withBrowser(async (browser) => {
    const page = await openDemo(browser, { onDisk: '1.2.2' });
    await pill(page).waitFor();
    await page.waitForTimeout(300);
    assert.equal(await dialog(page).count(), 0);
    assert.equal(await pill(page).textContent(), '重启 Steam 完成更新');
}));

test('手动检查：已跳过的版本也要弹窗，没连上时要说清楚', { skip: !playwright }, () => withBrowser(async (browser) => {
    const page = await openDemo(browser);
    await dialog(page).waitFor();
    await page.getByRole('button', { name: '暂不更新' }).click();
    const updated = await page.evaluate(() => window.__checkNow());
    assert.equal(updated.status, 'update');
    assert.equal(await dialog(page).count(), 1);
    await page.locator('.ac-update .ac-export__x').click();

    const offline = await openDemo(browser, { failFirst: 2 });
    await offline.waitForTimeout(1600);
    const failed = await offline.evaluate(() => window.__checkNow());
    assert.equal(failed.status, 'error');
    assert.match(failed.error, /Timeout/);
}));

test('已是最新版时什么都不显示', { skip: !playwright }, () => withBrowser(async (browser) => {
    const page = await openDemo(browser, { running: '1.2.2', onDisk: '1.2.2' });
    await page.waitForTimeout(1600);
    assert.equal(await pill(page).isVisible(), false);
    assert.equal(await dialog(page).count(), 0);
}));

/* ── 真实的 Lua 后端 ────────────────────────────────────────────────────── */

const wasmoon = load('AC_WASMOON_MODULE', 'wasmoon');

/** 内存里的文件系统和 Millennium 模块。renameFails / downloadFails 用来注入失败 */
const LUA_HARNESS = String.raw`
files = {}
renameFails = {}
writeFails = {}
downloadFails = {}
downloads = {}
logs = {}

local function file_object(path, mode)
    local buffer = ""
    local object = {}
    function object:read() return files[path] end
    function object:seek() return #files[path] end
    function object:write(data)
        if writeFails[path] then return nil, "磁盘写入失败" end
        buffer = buffer .. data
        return true
    end
    function object:close()
        if mode == "wb" and not writeFails[path] then files[path] = buffer end
    end
    return object
end

io = {
    open = function(path, mode)
        if mode == "wb" then
            if writeFails[path] then return nil, "磁盘写入失败" end
            return file_object(path, mode)
        end
        if files[path] == nil then return nil, "not found" end
        return file_object(path, mode)
    end,
}

os = {
    remove = function(path)
        if files[path] == nil then return nil, "not found" end
        files[path] = nil
        return true
    end,
    rename = function(from, to)
        if files[from] == nil then return nil, "not found" end
        -- 只失败一次：回滚时要能把旧文件改回来
        if renameFails[to] then
            renameFails[to] = nil
            return nil, "rename failed"
        end
        files[to] = files[from]
        files[from] = nil
        return true
    end,
}

local http = {}
function http.download(url, path, options)
    local name = url:match("([^/]+)$")
    downloads[name] = (downloads[name] or 0) + 1
    local left = downloadFails[name] or 0
    if left > 0 then
        downloadFails[name] = left - 1
        return nil, "Timeout was reached"
    end
    files[path] = "新版 " .. name
    return { status = 200 }
end

local modules = {
    logger = { info = function(_, text) logs[#logs + 1] = text end, error = function(_, text) logs[#logs + 1] = text end },
    millennium = { get_install_path = function() return "/mil" end, ready = function() end },
    utils = { get_backend_path = function() return "/plugin/backend" end },
    fs = { parent_path = function() return "/plugin" end },
    http = http,
}
function require(name) return modules[name] end
`;

const ROOT = '/plugin';
const TARGETS = {
    'AchievementCollection-plugin.js': '.millennium/Dist/index.js',
    'AchievementCollection-backend.lua': 'backend/main.lua',
    'AchievementCollection-showcase.js': 'showcase.js',
    'AchievementCollection-showcase.css': 'showcase.css',
};

async function loadBackend(version = '1.2.1') {
    const engine = await new wasmoon.LuaFactory().createEngine();
    await engine.doString(LUA_HARNESS);
    await engine.doString(`
        files["${ROOT}/plugin.json"] = '{ "name": "AchievementCollection", "version": "${version}", "useBackend": true }'
        ${Object.values(TARGETS).map((relative) => `files["${ROOT}/${relative}"] = "旧版"`).join('\n')}
    `);
    await engine.doString(readFileSync(path.join(THEME, 'plugin', 'backend', 'main.lua'), 'utf8'));
    return engine;
}

function installCall(version = '1.2.2', tag = `v${version}`) {
    const assets = Object.keys(TARGETS)
        .map((name) => `["${name}"] = { url = "https://github.com/Kevin0036/steam_achievement_improve/releases/download/${tag}/${name}", size = 0 }`)
        .join(',\n');
    return `return InstallUpdate({ version = "${version}", tag = "${tag}", assets = { ${assets} } })`;
}

/** 插件目录里现在有哪些文件 → 内容；留下 .update / .previous 也算在内 */
async function snapshot(engine) {
    return engine.doString(`
        local list = {}
        for path, data in pairs(files) do list[#list + 1] = path .. "=" .. data end
        table.sort(list)
        return table.concat(list, "\\n")
    `);
}

const oldState = (version = '1.2.1') => [
    `${ROOT}/.millennium/Dist/index.js=旧版`,
    `${ROOT}/backend/main.lua=旧版`,
    `${ROOT}/plugin.json={ "name": "AchievementCollection", "version": "${version}", "useBackend": true }`,
    `${ROOT}/showcase.css=旧版`,
    `${ROOT}/showcase.js=旧版`,
].join('\n');

test('后端：正常安装换掉全部文件，不留临时文件', { skip: !wasmoon }, async () => {
    const engine = await loadBackend();
    const result = await engine.doString(installCall());
    assert.equal(result.success, true, result.error);
    const after = await snapshot(engine);
    assert.match(after, /index\.js=新版 AchievementCollection-plugin\.js/);
    assert.match(after, /"version": "1\.2\.2"/);
    assert.doesNotMatch(after, /\.update|\.previous|=旧版/);
});

test('后端：下载超时一次会当场重试', { skip: !wasmoon }, async () => {
    const engine = await loadBackend();
    await engine.doString('downloadFails["AchievementCollection-plugin.js"] = 1');
    const result = await engine.doString(installCall());
    assert.equal(result.success, true, result.error);
    assert.equal(await engine.doString('return downloads["AchievementCollection-plugin.js"]'), 2);
});

test('后端：下载一直失败时旧文件原样保留', { skip: !wasmoon }, async () => {
    const engine = await loadBackend();
    await engine.doString('downloadFails["AchievementCollection-showcase.css"] = 5');
    const result = await engine.doString(installCall());
    assert.equal(result.success, false);
    assert.match(result.error, /下载失败/);
    assert.equal(await snapshot(engine), oldState());
});

test('后端：替换到一半失败时全部换回旧版', { skip: !wasmoon }, async () => {
    // 换文件的顺序是 backend → showcase.js → showcase.css → plugin.js，让最后一个失败
    const engine = await loadBackend();
    await engine.doString(`renameFails["${ROOT}/.millennium/Dist/index.js"] = true`);
    const result = await engine.doString(installCall());
    assert.equal(result.success, false);
    assert.equal(await snapshot(engine), oldState());
});

test('后端：写版本号失败时也全部换回旧版', { skip: !wasmoon }, async () => {
    const engine = await loadBackend();
    await engine.doString(`writeFails["${ROOT}/plugin.json.update"] = true`);
    const result = await engine.doString(installCall());
    assert.equal(result.success, false);
    assert.match(result.error, /plugin\.json/);
    assert.equal(await snapshot(engine), oldState());
});

test('后端：内测版能装同号正式版，装内测版时保留后缀', { skip: !wasmoon }, async () => {
    const beta = await loadBackend('1.2.2-beta');
    const formal = await beta.doString(installCall('1.2.2'));
    assert.equal(formal.success, true, formal.error);

    const stable = await loadBackend('1.2.1');
    const next = await stable.doString(installCall('1.2.2-beta'));
    assert.equal(next.success, true, next.error);
    assert.equal(next.version, '1.2.2-beta');
    assert.match(await snapshot(stable), /"version": "1\.2\.2-beta"/);
});

test('后端：拒绝旧版本、伪造地址和不合法的版本号', { skip: !wasmoon }, async () => {
    const engine = await loadBackend('1.2.2');
    assert.match((await engine.doString(installCall('1.2.2'))).error, /不比当前版本新/);

    const fresh = await loadBackend();
    const forged = await fresh.doString(`return InstallUpdate({ version = "1.2.2", tag = "v1.2.2", assets = {
        ["AchievementCollection-backend.lua"] = { url = "https://evil.example.com/releases/download/v1.2.2/x", size = 0 },
    } })`);
    assert.equal(forged.success, false);
    assert.match((await fresh.doString('return InstallUpdate({ version = "1.2.2-\\"x", tag = "v1.2.2" })')).error, /版本号无效/);
    assert.equal(await snapshot(fresh), oldState());
});
