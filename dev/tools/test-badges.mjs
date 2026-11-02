/**
 * 成就收藏册 · 徽章解析测试（Node，无需 Steam、无需浏览器）
 *
 * 覆盖两件事：
 *   1. level_names 的值可能是本地化对象，按客户端语言取值；
 *   2. 新版游戏的徽章图在 shared.steamstatic.com 的 community_assets 路径下。
 *
 * 用法：node tools/test-badges.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AC = path.join(HERE, '..', '..', 'millennium', 'themes', 'AchievementCollection', 'src', 'js', 'ac');

let failures = 0;
let checks = 0;
const check = async (name, run) => {
    checks += 1;
    try {
        await run();
        console.log(`  ok   ${name}`);
    } catch (err) {
        failures += 1;
        console.error(`  ✖   ${name}\n      ${err?.message ?? err}`);
    }
};

const badge = await import(pathToFileURL(path.join(AC, 'badges.js')).href);
const { __clearBadgeCache, badgeOptions, loadBadge, peekBadge, peekBadgeUrl } = badge;

const APPID = 3399960;
const CDN = `https://shared.steamstatic.com/community_assets/images/items/${APPID}/`;
const definition = (values) => [{
    appid: APPID,
    item_class: 1,
    item_type: 1,
    item_key_values: JSON.stringify(values),
}];

function setup(defs, { language = 'schinese', badgeData = null } = {}) {
    __clearBadgeCache();
    globalThis.SteamClient = { Settings: { GetCurrentLanguage: () => language } };
    globalThis.badgeStore = {
        GetCommunityItemDefinitions: () => defs,
        GetBadgeData: () => badgeData,
    };
}

const byKey = (options, key) => options.find((option) => option.key === key);

console.log('\n── 本地化名称 ───────────────────────────────────────');
await check('本地化名称对象按当前语言取值', async () => {
    setup(definition({
        level_images: { 1: 'lv1.png', 2: 'lv2.png', foil: 'foil.png' },
        level_names: {
            1: { schinese: '一级', english: 'Level One' },
            2: 'Level Two',
            foil: { schinese: '闪亮', english: 'Foil' },
        },
    }));
    const options = badgeOptions(await loadBadge(APPID));
    if (byKey(options, '1').name !== '一级') throw new Error(`Lv.1 名称 ${byKey(options, '1').name}`);
    if (byKey(options, '2').name !== 'Level Two') throw new Error(`Lv.2 名称 ${byKey(options, '2').name}`);
    if (byKey(options, 'foil').name !== '闪亮') throw new Error(`FOIL 名称 ${byKey(options, 'foil').name}`);
    if (byKey(options, '1').url !== `${CDN}lv1.png`) throw new Error(`Lv.1 地址 ${byKey(options, '1').url}`);
});

await check('当前语言缺失时回退中文，再回退任意字符串', async () => {
    setup(definition({
        level_images: { 1: 'lv1.png', 2: 'lv2.png' },
        level_names: {
            1: { schinese: '一级', english: 'Level One' },
            2: { japanese: 'レベル二' },
        },
    }), { language: 'tchinese' });
    const options = badgeOptions(await loadBadge(APPID));
    if (byKey(options, '1').name !== '一级') throw new Error(`Lv.1 名称 ${byKey(options, '1').name}`);
    if (byKey(options, '2').name !== 'レベル二') throw new Error(`Lv.2 名称 ${byKey(options, '2').name}`);
});

await check('客户端语言优先，并识别 zh-CN 写法', async () => {
    setup(definition({
        level_images: { 1: 'lv1.png' },
        level_names: { 1: { schinese: '一级', english: 'Level One' } },
    }), { language: 'english' });
    let options = badgeOptions(await loadBadge(APPID));
    if (byKey(options, '1').name !== 'Level One') throw new Error(`英文名称 ${byKey(options, '1').name}`);

    setup(definition({
        level_images: { 1: 'lv1.png' },
        level_names: { 1: { schinese: '一级', english: 'Level One' } },
    }), { language: 'zh-CN' });
    options = badgeOptions(await loadBadge(APPID));
    if (byKey(options, '1').name !== '一级') throw new Error(`中文名称 ${byKey(options, '1').name}`);
});

await check('缺少语言接口时仍优先中文名称', async () => {
    setup(definition({
        level_images: { 1: 'lv1.png' },
        level_names: { 1: { schinese: '一级', english: 'Level One' } },
    }));
    delete globalThis.SteamClient;
    const options = badgeOptions(await loadBadge(APPID));
    if (byKey(options, '1').name !== '一级') throw new Error(`Lv.1 名称 ${byKey(options, '1').name}`);
});

console.log('\n── 图片地址 ─────────────────────────────────────────');
await check('新版徽章图使用 community_assets 路径', async () => {
    setup(definition({ level_images: { 3: 'abc123.png' }, level_names: { 3: '三级' } }));
    const options = badgeOptions(await loadBadge(APPID));
    if (options[0].url !== `${CDN}abc123.png`) throw new Error(`地址 ${options[0].url}`);
    if (peekBadgeUrl(APPID, 3) !== `${CDN}abc123.png`) throw new Error(`peek 地址 ${peekBadgeUrl(APPID, 3)}`);
});

await check('完整地址原样保留，非字符串图片值被拒绝', async () => {
    setup(definition({
        level_images: { 1: 'https://example.com/lv1.png', 2: { url: 'lv2.png' } },
        level_names: { 1: '一级', 2: '二级' },
    }));
    const options = badgeOptions(await loadBadge(APPID));
    if (byKey(options, '1').url !== 'https://example.com/lv1.png') throw new Error(`Lv.1 地址 ${byKey(options, '1').url}`);
    if (byKey(options, '2')) throw new Error('对象地址不应生成徽章选项');
});

await check('GetBadgeData 的本地化名称与旧 CDN 地址也能显示', async () => {
    setup([], {
        badgeData: {
            nLevel: 4,
            strIconURL: `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/items/${APPID}/lv4.png`,
            strName: { schinese: '四级', english: 'Level Four' },
        },
    });
    const options = badgeOptions(peekBadge(APPID));
    if (options.length !== 1) throw new Error(`选项数 ${options.length}`);
    if (options[0].name !== '四级') throw new Error(`名称 ${options[0].name}`);
    if (options[0].url !== `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/items/${APPID}/lv4.png`) {
        throw new Error(`地址 ${options[0].url}`);
    }
});

if (failures > 0) {
    console.error(`\n${failures} 项失败（共 ${checks} 项）`);
    process.exit(1);
}
console.log(`\n✔ ${checks} 项断言全部通过`);
