/**
 * 成就收藏册 · 卡包主页面
 *
 * 页面按「可在任意容器内挂载」设计：入口的四个降级级别（见 mount.js）
 * 共用这一份 page.js，只是挂载点不同。
 *
 * 展示层只读 store，不认识任何 Steam API。
 * 页面本体是一本摊开的收藏册（book.js），这里只负责：
 *   · 状态页（读取中 / 等待数据 / 空 / 出错）画成一本合上的册子；
 *   · 把卡片按**完成时间倒序**交给 book（最近完成的摊开在第一页）；
 *   · 完成日期是逐张补上来的：补的过程中只就地换那一张卡，
 *     全部补完后再重新装订一次，并把当前正在看的那张留在原处；
 *   · 新全成就的游戏先不放进册子，等它的完成日期到了，交给 book.introduce() 播入册动画，
 *     播完才记为「已入册」—— 中途离开的话，下次进来还会再播。
 */

import { getReact, getReactDom, getThemeOption } from './env.js';
import * as store from './store.js';
import { createBook } from './book.js';
import { tagged } from './utils.js';
import { STR } from './strings.js';

const out = tagged('page');

/* ── 订阅 store ─────────────────────────────────────────────────────────── */

function useStoreState() {
    const React = getReact();
    const [snapshot, setSnapshot] = React.useState(() => store.getState());

    React.useEffect(() => {
        const unsubscribe = store.subscribe(() => setSnapshot(store.getState()));
        return unsubscribe;
    }, []);

    return snapshot;
}

/* ── 纯 DOM 小工具 ──────────────────────────────────────────────────────── */

function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/** 合上的册子 + 一句说明（可带一个按钮），用来渲染各种状态页 */
function renderStatePage(host, { title, desc, action }) {
    const doc = host.ownerDocument;
    const box = el(doc, 'div', 'ac-state__cover');
    box.append(el(doc, 'div', 'ac-state__badge', null));
    box.lastChild.setAttribute('aria-hidden', 'true');
    box.append(el(doc, 'div', 'ac-state__title', title));
    if (desc) box.append(el(doc, 'div', 'ac-state__desc', desc));
    if (action) {
        const actions = el(doc, 'div', 'ac-state__actions');
        const button = el(doc, 'button', 'ac-state__btn', action.label);
        button.type = 'button';
        button.addEventListener('click', action.onClick);
        actions.append(button);
        box.append(actions);
    }
    const wrap = el(doc, 'div', 'ac-state', null);
    wrap.append(box);
    host.replaceChildren(wrap);
    out.log(`状态页：${title}`);
}

function statePageProps(phase, state, onRetry) {
    switch (phase) {
        case 'not-ready':
            return {
                title: STR.page.notReadyTitle,
                desc: STR.page.notReadyDesc,
                action: { label: STR.page.notReadyRetry, onClick: onRetry },
            };
        case 'empty':
            return { title: STR.page.emptyTitle, desc: STR.page.emptyDesc };
        case 'error':
            return {
                title: STR.page.errorTitle,
                desc: state.error ?? STR.page.errorDescFallback,
                action: { label: STR.page.errorRetry, onClick: onRetry },
            };
        case 'loading':
        default:
            return { title: STR.page.loadingTitle, desc: STR.page.loadingDesc };
    }
}

/* ── 页面 ───────────────────────────────────────────────────────────────── */

/** 卡面上会画出来的那几样数据；变了才需要重画这张卡 */
function cardSignature(card) {
    return `${card.name}|${card.completedAt ?? ''}|${card.rare ?? ''}|${card.common ?? ''}|${card.unrated ?? ''}|${card.playtimeMin ?? ''}|${card.total ?? ''}|${JSON.stringify(card.art ?? null)}`;
}

const orderOf = (cards) => cards.map((c) => c.appid).join(',');

/** 主题设置「单页卡片数量」：只认 1 / 4，其余一律按 1 处理 */
const currentPerPage = () => (String(getThemeOption('单页卡片数量', '1')) === '4' ? 4 : 1);

export function Page() {
    const React = getReact();
    const state = useStoreState();
    const hostRef = React.useRef(null);
    const bookRef = React.useRef(null);
    const builtRef = React.useRef({ order: '', owner: '', state: '', perPage: 0 });
    /** 正在播的入册动画（一个令牌，防止旧书的回调影响新书） */
    const introRef = React.useRef(null);

    // 首次挂载：读数据 + 取当前账号（再挂载时走 silent，避免用缓存先铺一层造成闪烁）
    React.useEffect(() => {
        const hasCards = store.getState().cards.length > 0;
        store.load({ silent: hasCards });
        store.loadOwner();
        return () => store.pause();
    }, []);

    const onRetry = React.useCallback(() => store.refresh(), []);

    React.useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        const ordered = store.selectVisibleCards();
        const phase = state.phase === 'ready' && ordered.length === 0 ? 'empty' : state.phase;
        const perPage = currentPerPage();

        // 新收录、还没入册的卡先不放进册子（入册动画开始后由 book 自己接手）
        const pending = introRef.current ? new Set() : new Set(state.intro.appids);
        const shown = pending.size > 0 ? ordered.filter((c) => !pending.has(c.appid)) : ordered;

        const destroyBook = () => {
            bookRef.current?.destroy();
            bookRef.current = null;
            introRef.current = null;
            builtRef.current = { order: '', owner: '', state: '', perPage: 0 };
        };

        if (phase !== 'ready') {
            destroyBook();
            // 同一个状态页只画一次，别让每次 store 通知都重建 DOM
            if (builtRef.current.state !== phase) {
                const props = statePageProps(phase, state, onRetry);
                renderStatePage(host, props);
                builtRef.current.state = phase;
            } else if (phase === 'error') {
                // 错误信息可能变了，重画一次
                renderStatePage(host, statePageProps(phase, state, onRetry));
            }
            return;
        }

        const orderKey = orderOf(shown);
        const ownerKey = `${state.owner?.persona ?? ''}|${state.owner?.avatar ?? ''}`;

        if (bookRef.current && (builtRef.current.owner !== ownerKey || builtRef.current.perPage !== perPage)) {
            // 昵称/头像晚到了，或单页数量改了：整册重画一次
            destroyBook();
        }

        if (!bookRef.current) {
            host.replaceChildren();
            bookRef.current = createBook(host, { cards: shown, owner: state.owner ?? {}, perPage });
            builtRef.current = { order: orderKey, owner: ownerKey, state: '', perPage };
            out.log(`收藏册已装订：${shown.length} 张卡（每页 ${perPage} 张）`);
        } else if (!state.dates.running && orderKey !== builtRef.current.order) {
            // 日期补完了，重新按完成时间装订。
            // 还停在第一页（没翻过）就直接摊开最近完成的那张；翻过了就把正在看的那张留在原处。
            const book = bookRef.current;
            const keepAppid = book.index === 0 ? null : book.cards[book.index]?.appid ?? null;
            book.replaceCards(shown, { keepAppid, atStart: keepAppid == null });
            builtRef.current.order = orderKey;
            out.log('完成日期已补全，收藏册重新装订');
        } else {
            // 日期 / 稀有数 / 游戏名是逐张补上来的：只换变了的那几张卡，不重排
            const book = bookRef.current;
            const current = new Map(book.cards.map((c) => [c.appid, c]));
            for (const card of ordered) {
                const before = current.get(card.appid);
                if (before && cardSignature(before) !== cardSignature(card)) book.updateCard(card.appid, card);
            }
        }

        // 新收录的完成日期有结果了：播入册动画
        if (pending.size > 0 && state.intro.ready) {
            const book = bookRef.current;
            const appids = [...pending];
            const token = {};
            introRef.current = token;
            builtRef.current.order = orderOf(ordered);
            out.log(`新卡入册：${appids.join(', ')}`);
            book.introduce(ordered, appids).then((done) => {
                if (introRef.current !== token) return;
                introRef.current = null;
                if (done) store.markIntroduced(appids);
            });
        }
    });

    React.useEffect(
        () => () => {
            bookRef.current?.destroy();
            bookRef.current = null;
        },
        [],
    );

    return React.createElement(
        'div',
        { className: 'ac-cardpack', 'data-ac': 'cardpack' },
        React.createElement('div', { className: 'ac-book-host', ref: hostRef, 'data-ac': 'book-host' }),
    );
}

/** 供 mount.js 在降级 2（模态）里复用 */
export function renderInto(container) {
    const React = getReact();
    const ReactDOM = getReactDom();
    if (!React || !ReactDOM?.createRoot) return null;
    const root = ReactDOM.createRoot(container);
    root.render(React.createElement(Page));
    return root;
}

export const __debug = { out };
