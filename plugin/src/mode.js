/**
 * 必须在导入任何 src/js/ac/* 之前执行：
 *   · 打开本脚本实例的插件模式（page.js 显示设置入口、mount.js 跳过重复注入）；
 *   · 把插件选项接到 getThemeOption 上。
 *
 * ES 模块按 import 书写顺序求值，所以 index.js 把这个模块放在第一位。
 */

import { setOptionProvider, setPluginMode } from '../../src/js/ac/env.js';
import { DEFAULTS, readOptions } from './settings.js';

/* esbuild 在打包时用 plugin.json 里的版本替换这个标识符 */
const VERSION = typeof __AC_PLUGIN_VERSION__ === 'string' ? __AC_PLUGIN_VERSION__ : 'dev';

setPluginMode(true);
/* mount.js 的启动横幅用；主题版有自己的版本号，不会读这个 */
window.__AC_PLUGIN_VERSION__ = VERSION;

setOptionProvider((name) => (name in DEFAULTS ? readOptions()[name] : undefined));

export const PLUGIN_VERSION = VERSION;
export const PLUGIN_NAME = 'AchievementCollection';
