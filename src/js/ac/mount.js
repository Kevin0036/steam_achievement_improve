/**
 * 成就收藏册 · 功能 B 的入口注册（含四级降级）
 *
 * ── 为什么主选是 jsx-runtime 补丁 ────────────────────────────────────────
 * 已从 lib/millennium.dll 里核实 RouterHook 的两条硬约束：
 *   1. `addRoute` 注入的路由**永远被追加到最后**（processList 写 e[e.length]）；
 *   2. 库的内层路由表收到的 routes 参数是 `null`，
 *      所以 **`addRoute` 根本进不了库的子路由表**，只有 addPatch 生效。
 * 而 Steam 库的内层 Switch 最后一项是**无 path 的兜底 Route**
 * （react-router v5 的 Switch 不会把它当命中项，等于死代码）。
 * 所以我们不去碰路由注册表，而是直接对这一棵 JSX 树做最小追加：
 * 在库内层 Switch 的 children 里，往兜底 Route 之前插入我们的一条 Route。
 *
 * 这个手法在本机有先例：`achievement-groups` 插件就是用
 * `beforePatch(jsxRuntime, 'jsx'|'jsxs', cb)` 往游戏详情页的 tabs 数组里塞标签页的。
 *
 * ── 四级降级 ─────────────────────────────────────────────────────────────
 *   1  主选      jsx-runtime 追加 Route（保留侧栏与游戏列表）
 *   2  降级 1    routerHook.addPatch('/library', …) —— 会替换整个库外壳，
 *                侧栏与游戏列表都会被移除。**默认关闭**，需要在主题设置里显式打开。
 *   3  降级 2    showModal 打开模态卡包，不动路由，零侵入
 *   4  降级 3    功能 B 整体静默禁用，控制台留一条说明，Steam 库完全不受影响
 */

import { getReact, getPluginList, waitForGlobal, getThemeOption } from './env.js';
import { ROUTES, SUPERNAV_TITLE, isLibraryRouteSwitch, isLibrarySupernav, MENU } from './selectors.js';
import { Page } from './page.js';
import { banner, warn, fail, Disposables, tagged } from './utils.js';
import { STR } from './strings.js';

const out = tagged('mount');

/** 当前实际生效的降级级别，供 selftest 报告 */
const status = {
    level: 0,
    routeInjected: false,
    menuInjected: false,
    menuInjectFailed: false,
    gateInstalled: false,
    error: null,
};

export const getMountStatus = () => ({ ...status });

/* ── jsx-runtime 探测器 ─────────────────────────────────────────────────── */

async function findJsxRuntime(api) {
    const found = await waitForGlobal('SP_REACT', { timeout: 30000 });
    if (!found) out.log('SP_REACT 未就绪，仍然尝试直接找 jsx-runtime 模块');

    const runtime = api.findModuleByExport?.(
        (value, key) => (key === 'jsx' || key === 'jsxs') && typeof value === 'function',
    );

    if (!runtime || typeof runtime.jsx !== 'function' || typeof runtime.jsxs !== 'function') return null;
    return runtime;
}

/* ── 往 JSX 树里做最小追加 ──────────────────────────────────────────────── */

function injectRoute(type, props) {
    if (!isLibraryRouteSwitch(props)) return;

    const children = props.children;
    if (!Array.isArray(children)) return;
    if (children.some((child) => child?.props?.path === ROUTES.cardPack)) return;

    const Route = children[0]?.type;
    if (!Route) return;

    const React = getReact();
    if (!React) return;

    const element = React.createElement(
        Route,
        { key: 'ac-cardpack-route', path: ROUTES.cardPack },
        React.createElement(Page, null),
    );

    // 插到第一个「没有 path」的兜底 Route 之前 —— 这是库内层 Switch 的最后一项。
    // 虽然 react-router v5 不会让兜底项命中，但插在它前面语义上更正确，
    // 万一将来 Valve 给兜底加上 path，我们也不会被它抢走。
    const fallbackIndex = children.findIndex((child) => !child?.props?.path);
    if (fallbackIndex >= 0) children.splice(fallbackIndex, 0, element);
    else children.push(element);

    if (!status.routeInjected) out.log(`已把 ${ROUTES.cardPack} 追加进库内层路由表`);
    status.routeInjected = true;
}

/**
 * 给 Library Supernav 的固定 key。
 *
 * Supernav 的下拉菜单不是每次渲染都重新生成的：组件**第一次挂载**时就用当时的
 * menuItems 建好一个菜单实例（CreateContextMenuInstance，bRetainOnHide），之后一直复用，
 * 再也不读新的 menuItems（sp.js 里 `we = Ne => { …!fe.current && (fe.current = …) }`）。
 * Steam 启动时 Supernav 比主题脚本先挂载，于是菜单里一直是没有我们这一项的旧列表，
 * 直到切换主题让它重新挂载才会出现。
 *
 * 解决办法：我们第一次碰到它时给它一个固定 key。key 从「无」变成这个值，
 * React 会把它卸载重挂一次，菜单实例随之按带着我们这一项的新列表重建；
 * 之后 key 再也不变，不会反复重挂。旧的菜单实例由 Steam 自己的卸载逻辑释放
 * （`useEffect(() => () => ReleaseHiddenMenu(fe.current))`）。
 */
const SUPERNAV_KEY = 'ac-library-supernav';

function injectMenuItem(type, props) {
    if (!isLibrarySupernav(props)) return;

    // React 19 的 jsx() 会从 config 上读 key，并且不会把它当成 prop 传下去
    if (props.key === undefined) props.key = SUPERNAV_KEY;

    // menuItems 每次渲染都是新数组，所以每次都要补；日志只打第一次
    const items = props.menuItems;
    if (items.some((item) => item?.route === ROUTES.cardPack)) return;
    items.push({ name: `${MENU.icon} ${STR.page.heading}`, route: ROUTES.cardPack });

    if (!status.menuInjected) out.log('已把「成就卡包」加入 Library Supernav 下拉菜单');
    status.menuInjected = true;
}

/* ── 降级 2：替换库外壳（默认关闭） ─────────────────────────────────────── */

function installLibraryGate(api) {
    const React = getReact();
    if (!React) return false;

    const enabled = String(getThemeOption('成就卡包：允许全屏式入口', 'no')) === 'yes';
    if (!enabled) {
        out.log('降级 1（替换库外壳）未启用；如主选方案失效，可在主题设置里打开它');
        return false;
    }

    try {
        api.routerHook.addPatch(
            ROUTES.libraryRoot,
            (props) => {
                const original = props.children;
                return {
                    children: React.createElement(Gate, { original }),
                };
            },
            api.EUIMode?.Desktop ?? 7,
        );
        status.gateInstalled = true;
        out.log("降级 1 已安装：/library 外壳被 Gate 包裹，进入卡包时会暂时移除库侧栏");
        return true;
    } catch (err) {
        warn('安装降级 1 失败', err);
        return false;
    }
}

/**
 * Gate：只在路径命中我们的页面时接管渲染。
 * 路径通过一个很短的有界轮询跟踪 —— Steam 的 pushState 不会触发 popstate。
 */
function Gate({ original }) {
    const React = getReact();
    const [mine, setMine] = React.useState(isOurPath);

    React.useEffect(() => {
        const timer = window.setInterval(() => setMine(isOurPath()), 250);
        return () => clearInterval(timer);
    }, []);

    if (!mine) return original ?? null;
    return React.createElement(
        'div',
        { className: 'ac-page-host', 'data-ac': 'page-host', style: { width: '100%', height: '100%' } },
        React.createElement(Page, null),
    );
}

function isOurPath() {
    try {
        return window.location.pathname.startsWith(ROUTES.cardPack);
    } catch {
        return false;
    }
}

/* ── 降级 3：模态 ───────────────────────────────────────────────────────── */

function openModal(api) {
    const React = getReact();
    if (!React) {
        fail('React 不可用，无法打开模态卡包');
        return false;
    }

    const owner = getPluginList()?.core?.mainWindow ?? window;
    try {
        api.showModal(React.createElement(Page, null), owner, {
            popupHeight: 820,
            popupWidth: 1280,
            bAllowFullSize: true,
        });
        out.log('降级 2：已用 showModal 打开卡包');
        return true;
    } catch (err) {
        warn('打开模态失败', err);
        return false;
    }
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */

export async function mount({ disposables } = {}) {
    const api = await waitForGlobal('MILLENNIUM_API', { timeout: 30000 });
    if (!api) {
        status.level = 4;
        status.error = 'MILLENNIUM_API 不可用';
        fail('MILLENNIUM_API 不可用，功能 B 整体禁用（Steam 库不受任何影响）');
        return status;
    }

    const runtime = await findJsxRuntime(api);
    if (runtime) {
        const handle = (type, props) => {
            try {
                injectRoute(type, props);
                injectMenuItem(type, props);
            } catch (err) {
                // 绝不让异常冒泡到 React 的渲染流程里 —— 那会影响整个 Steam 界面
                warn('jsx 补丁回调抛错（已吞下）', err);
            }
        };

        const patches = [];
        for (const name of ['jsx', 'jsxs']) {
            try {
                const patch = api.beforePatch(runtime, name, (args) => handle(args?.[0], args?.[1]));
                patches.push({ name, patch, last: runtime[name] });
                out.log(`已挂钩 react/jsx-runtime.${name}`);
            } catch (err) {
                warn(`挂钩 ${name} 失败`, err);
            }
        }

        if (patches.length > 0) {
            status.level = 1;

            // Steam 在某些时机（例如切换 UI 模式）会换掉这个模块，补丁会丢。
            // 用一段时间的有界看门狗自动重挂，90 秒后停止，不留常驻定时器。
            const started = Date.now();
            const watchdog = window.setInterval(() => {
                if (Date.now() - started > 90_000) {
                    clearInterval(watchdog);
                    out.log('jsx-runtime 看门狗已停止');
                    return;
                }
                for (const entry of patches) {
                    if (runtime[entry.name] === entry.last) continue;
                    out.log(`检测到 ${entry.name} 被替换，重新挂钩`);
                    try {
                        entry.patch?.unpatch?.();
                    } catch {
                        /* 忽略 */
                    }
                    try {
                        entry.patch = api.beforePatch(runtime, entry.name, (args) =>
                            handle(args?.[0], args?.[1]),
                        );
                        entry.last = runtime[entry.name];
                    } catch (err) {
                        warn(`重新挂钩 ${entry.name} 失败`, err);
                    }
                }
            }, 1000);

            disposables?.addInterval?.(watchdog);
            disposables?.add?.(() => {
                clearInterval(watchdog);
                for (const entry of patches) {
                    try {
                        entry.patch?.unpatch?.();
                    } catch {
                        /* 忽略 */
                    }
                }
            });

            return status;
        }
    }

    // 主选不可用
    status.menuInjectFailed = true;
    warn('主选方案（jsx-runtime 追加路由）不可用，进入降级');

    if (installLibraryGate(api)) {
        status.level = 2;
        return status;
    }

    out.log('降级 2（模态）需要在用户点击入口时才能打开，注册一个全局入口');
    registerGlobalEntry(api, disposables);
    status.level = 3;
    return status;
}

/**
 * 主选与降级 1 都不可用时的兜底入口：
 * 用 routerHook.addGlobalComponent 挂一个小小的浮动按钮，
 * 点击后用 showModal 打开卡包。不动路由，零侵入。
 */
function registerGlobalEntry(api, disposables) {
    const React = getReact();
    if (!React || !api.routerHook?.addGlobalComponent) return;

    function EntryButton() {
        return React.createElement(
            'button',
            {
                type: 'button',
                className: 'ac-entry-btn',
                style: {
                    position: 'fixed',
                    right: '26px',
                    bottom: '26px',
                    zIndex: 2147483000,
                    height: '34px',
                    padding: '0 14px',
                    font: 'inherit',
                    fontWeight: 600,
                    color: '#fff',
                    cursor: 'pointer',
                    border: '1px solid rgba(255,255,255,0.14)',
                    borderRadius: '8px',
                    background: 'rgb(102,108,255)',
                    boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
                },
                onClick: () => openModal(api),
                title: '打开成就卡包',
            },
            `${MENU.icon} ${STR.page.heading}`,
        );
    }

    try {
        api.routerHook.addGlobalComponent(
            'AchievementCollectionEntry',
            EntryButton,
            api.EUIMode?.Desktop ?? 7,
        );
        disposables?.add?.(() => {
            try {
                api.routerHook.removeGlobalComponent?.('AchievementCollectionEntry', api.EUIMode?.Desktop ?? 7);
            } catch {
                /* 忽略 */
            }
        });
        out.log('降级 2：已注册全局入口按钮');
    } catch (err) {
        warn('注册全局入口失败', err);
    }
}

export const __debug = { status, isOurPath, injectRoute, injectMenuItem, openModal, SUPERNAV_TITLE };

/* ── 自启动 ─────────────────────────────────────────────────────────────── */

(async function bootstrap() {
    const VERSION = '1.0.0';

    try {
        banner(STR.theme, VERSION);
    } catch {
        /* 不影响功能 */
    }

    const disposables = new Disposables();

    try {
        // 主题设置：是否读取完成日期
        const datesEnabled = String(getThemeOption('成就卡包：读取完成日期', 'yes')) === 'yes';
        const storeModule = await import('./store.js');
        storeModule.setDatesEnabled(datesEnabled);
        if (!datesEnabled) out.log('完成日期读取已按主题设置关闭');

        await mount({ disposables });

        const { installSelfTest } = await import('./selftest.js');
        installSelfTest();

        // 把环境探测结果打出来 —— 初始化日志里就能看到实际命中路径
        const { snapshot } = await import('./env.js');
        out.log('环境探测', snapshot().hits);

        disposables.addListener(window, 'pagehide', () => {
            storeModule.pause();
            disposables.disposeAll();
        });
    } catch (err) {
        // 绝不让异常冒泡到 Steam 的渲染流程里
        fail('初始化失败，功能 B 已停用（Steam 库本身不受影响）', err);
    }
})();