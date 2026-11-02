/**
 * 把 SpaceTheme 的 skin.json 改造成「成就收藏册」的 skin.json。
 *
 * 做四件事：
 *   1. 改名（显示名 / 描述 / 标签），把 github 指向我们自己的仓库、去掉 funding /
 *      discord_support，避免 Millennium 把主题当成 SpaceTheme 上游来更新。
 *   2. 把用户当前在 SpaceTheme 上调好的 Conditions 值烘焙成新主题的 default，
 *      因为 Millennium 的 themes.conditions 以「主题目录名」为 key，
 *      新目录名拿不到旧配置，只能靠 default 继承观感。
 *   3. 追加我们自己的 Patches 条目。
 *   4. 移除 header_image / splash_image（那是 SpaceTheme 的品牌图）。
 *
 * 用法：node tools/build-skin.mjs
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STEAM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..').replaceAll('\\', '/');
const THEME_DIR = `${STEAM_ROOT}/millennium/themes/AchievementCollection`;
const SOURCE_SKIN = `${THEME_DIR}/skin.json`;
const CONFIG = `${STEAM_ROOT}/millennium/config/config.json`;

const THEME_NAME = '成就收藏册';
const THEME_DESCRIPTION =
  '在 SpaceTheme（MIT）之上的个人化分支：新增「成就卡包」库内页面与 Steam 社区完满主义者展柜美化。';

// ---------------------------------------------------------------------------

const skin = JSON.parse(readFileSync(SOURCE_SKIN, 'utf8'));
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));

const userConditions = config?.themes?.conditions?.Steam ?? {};

// 1) 身份 ---------------------------------------------------------------------
skin.name = THEME_NAME;
skin.description = THEME_DESCRIPTION;
skin.author = 'Kevin (fork of SpaceTheme by SpaceEnergy)';
skin.tags = ['Modular', 'Dark', 'Customizable', 'Achievements'];

// 换成我们自己的仓库：Millennium 的「检查更新」才会指向成就收藏册，
// 而不是 SpaceTheme 上游；metadata.json 里的 commit 由发布脚本维护。
skin.github = { owner: 'Kevin0036', repo_name: 'steam_achievement_improve' };
delete skin.funding;
delete skin.discord_support;
delete skin.header_image;
delete skin.splash_image;

// 2) 把用户当前的选项烘焙成默认值 -----------------------------------------------
const applied = [];
const skipped = [];

for (const [name, condition] of Object.entries(skin.Conditions ?? {})) {
  const current = userConditions[name];
  if (current === undefined) continue;

  if (condition.slider) {
    // Millennium 把滑块值以字符串形式存进 config.json，这里统一转成数字。
    const numeric = typeof current === 'number' ? current : Number.parseFloat(current);
    if (Number.isFinite(numeric)) {
      condition.default = numeric;
      applied.push(`${name} = ${numeric}`);
    } else {
      skipped.push(`${name} (slider, 值不是数字: ${JSON.stringify(current)})`);
    }
    continue;
  }

  if (condition.values) {
    if (Object.prototype.hasOwnProperty.call(condition.values, current)) {
      condition.default = current;
      applied.push(`${name} = ${current}`);
    } else {
      skipped.push(`${name} (选项里没有 ${JSON.stringify(current)})`);
    }
  }
}

// 3) 追加我们的 Conditions ----------------------------------------------------
//    这两个必须是本项目自己的，不能被上面那轮「烘焙用户设置」覆盖 ——
//    用户当前的 SpaceTheme 配置里没有这两个名字，所以它们的 default 会原样保留。
skin.Conditions['成就卡包：读取完成日期'] = {
  description:
    '把每款全成就游戏「最后一个成就的解锁时间」作为完成日期显示在卡片上。\n' +
    '[i]数据来自 SteamClient.Apps.GetMyAchievementsForApp：串行、按需、按 appid 去重，' +
    '结果缓存 30 天，不会产生高频请求。关闭后卡片上不显示完成日期。[/i]',
  default: 'yes',
  tab: 'Library',
  section: '成就卡包',
  values: { yes: {}, no: {} },
};

skin.Conditions['成就卡包：允许全屏式入口'] = {
  description:
    '主选入口（往 Steam 库的内层路由表追加一个页面）失效时的一级降级：直接替换 /library 外壳。\n' +
    '[i]代价：进入卡包时会同时移除库侧栏与游戏列表。默认关闭；关闭时改用模态窗口打开卡包，完全不动路由。[/i]',
  default: 'no',
  tab: 'Library',
  section: '成就卡包',
  values: { no: {}, yes: {} },
};

// 4) 追加我们的 Patches --------------------------------------------------------
// 说明：TargetCss / TargetJs 是会被当成真实 URL 注入的
//       (https://millennium.host/v1/themes/AchievementCollection/<path>)，
//       所以这些文件里的相对 @import 能正常解析。这里不再往 root.css / webkit.css
//       里塞 @import —— 直接多挂一条 Patch 更干净，也不碰 SpaceTheme 的令牌文件。
skin.Patches = skin.Patches.filter(
  (p) => !String(p.TargetCss ?? '').includes('ac/') && !String(p.TargetJs ?? '').includes('ac/'),
);

skin.Patches.push(
  // 全局：设计令牌（金 / 蓝 / 间距 / 圆角），展柜与卡片共用
  { MatchRegexString: '.*', TargetCss: 'src/css/ac/tokens.css' },
  // 库内：成就卡包页面（cardpack.css 内部再 @import book/card）
  {
    MatchRegexString: '^Steam$',
    TargetCss: 'src/css/ac/cardpack.css',
    TargetJs: 'src/js/ac/mount.js',
  },
  // 社区：完满主义者展柜
  {
    MatchRegexString: 'https://steamcommunity\\.com(/.*)?',
    TargetCss: 'src/css/ac/showcase.css',
    TargetJs: 'src/js/ac/profile.js',
  },
);

// 4) 落盘 ---------------------------------------------------------------------
writeFileSync(SOURCE_SKIN, JSON.stringify(skin, null, 4) + '\n', 'utf8');

// 备份一份原始 skin.json 以便对比
copyFileSync(`${STEAM_ROOT}/millennium/themes/Steam/skin.json`, `${THEME_DIR}/skin.upstream.json`);

console.log(`烘焙了 ${applied.length} 项用户设置为本主题默认值，跳过 ${skipped.length} 项。`);
if (skipped.length) console.log('跳过：\n  ' + skipped.join('\n  '));
console.log('Patches 条目：' + skin.Patches.length);