/**
 * 借阅室（生产版）
 *
 * 只做一件事：读取链接里的 token，向分享 API 取一份只读快照，用主题里
 * 真实的 createBook 渲染。没有编辑入口，不上传任何访客数据。
 *
 * 构建时写入 API 基址；本地联调时可指向 127.0.0.1。
 */

import { createBook } from '../../../millennium/themes/AchievementCollection/src/js/ac/book.js';
import { setOptionProvider } from '../../../millennium/themes/AchievementCollection/src/js/ac/env.js';
import { createRoomSound } from '../../../millennium/themes/AchievementCollection/src/js/ac/roomsound.js';

const API_BASE = typeof __AC_API_BASE__ === 'string' ? __AC_API_BASE__ : 'https://ac-share.duckdns.org:8443';
const DEBUG = typeof __AC_DEBUG__ === 'boolean' ? __AC_DEBUG__ : false;

/* ── 基础 ─────────────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPEED = reduceMotion ? 0.14 : 1;

const room = $('room');
const mail = $('mail');
const letter = $('letter');
const seal = $('seal');
const ring = $('ring');
const veil = $('veil');
const cover = $('cover');
const reader = $('reader');
const bookHost = $('bookHost');
const statusPanel = $('statusPanel');
const codePanel = $('codePanel');
const codeField = $('codeField');
const codeInput = $('codeInput');
const codeHint = $('codeHint');
const mark = $('mark');
const openBookBtn = $('openBookBtn');
const sound = createRoomSound({
    doc: document,
    button: $('soundBtn'),
    src: new URL('audio/reading-room.mp3', document.baseURI).href,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms * SPEED));
const once = (node, type = 'click') => new Promise((resolve) => node.addEventListener(type, resolve, { once: true }));
const play = (node, cls) => {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
};

let toastTimer = 0;
function toast(text, ms = 2100) {
    const node = $('toast');
    node.textContent = text;
    node.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('on'), ms);
}

function tip(text) {
    const node = $('tip');
    node.textContent = text || '';
    node.classList.toggle('on', !!text);
}

function burst(host, count, x, y) {
    for (let i = 0; i < count; i += 1) {
        const dot = document.createElement('i');
        dot.className = 'rm-dust';
        const angle = Math.random() * 6.283;
        const dist = 1.4 + Math.random() * 4;
        dot.style.cssText = `left:${x};top:${y};--x:${(Math.cos(angle) * dist * 1.4).toFixed(2)}em;--y:${(Math.sin(angle) * dist - 1).toFixed(2)}em;animation-delay:${(Math.random() * 0.1).toFixed(2)}s`;
        host.appendChild(dot);
        setTimeout(() => dot.remove(), 1200);
    }
}

const pad2 = (n) => String(n).padStart(2, '0');
const fmtDay = (seconds) => {
    const d = new Date(seconds * 1000);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const fmtShort = (seconds) => {
    const d = new Date(seconds * 1000);
    return `${d.getMonth() + 1}.${d.getDate()}`;
};

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.append(area);
        area.select();
        let ok = false;
        try {
            ok = document.execCommand('copy');
        } catch {
            ok = false;
        }
        area.remove();
        return ok;
    }
}

/* ── 快照请求 ─────────────────────────────────────────────────────────── */

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CODE_RE = /^\d{9}$/;
const normalizeCode = (value) => String(value ?? '').replace(/[\s-]/g, '');
const groupCode = (value) => normalizeCode(value).replace(/(\d{3})(?=\d)/g, '$1 ').trim();
const rawCode = normalizeCode(q.get('c') ?? '');
const token = (q.get('t') ?? '').trim();
let target = null;
if (q.has('c')) {
    if (CODE_RE.test(rawCode)) target = { kind: 'code', value: rawCode };
} else if (token) {
    target = { kind: 'token', value: token };
}

async function requestAlbum(active) {
    const endpoint = active.kind === 'code'
        ? `${API_BASE}/api/albums/by-code/${encodeURIComponent(active.value)}`
        : `${API_BASE}/api/albums/${encodeURIComponent(active.value)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let res;
    try {
        res = await fetch(endpoint, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: ctrl.signal,
        });
    } catch {
        return { kind: 'network' };
    } finally {
        clearTimeout(timer);
    }
    if (res.status === 404) return { kind: 'gone' };
    if (res.status === 429) return { kind: 'rate' };
    if (!res.ok) return { kind: 'network' };
    let data;
    try {
        data = await res.json();
    } catch {
        return { kind: 'network' };
    }
    if (Number(data?.schemaVersion) > 1) return { kind: 'upgrade' };
    if (
        !data ||
        data.kind !== 'achievement-album' ||
        Number(data.schemaVersion) !== 1 ||
        !data.owner ||
        !Array.isArray(data.cards)
    ) {
        return { kind: 'network' };
    }
    if (data.cards.length === 0) return { kind: 'empty' };
    return { data };
}

/* ── 借阅数据 ─────────────────────────────────────────────────────────── */

let albumData = null;
let busy = false;
let reading = false;
let canOpenBook = false;

const view = { perPage: 1, years: false };

function yearOf(card) {
    return Number.isFinite(card?.completedAt) ? String(new Date(card.completedAt * 1000).getFullYear()) : 'unknown';
}

function albumSpan(cards) {
    const years = cards
        .map((card) => (Number.isFinite(card?.completedAt) ? new Date(card.completedAt * 1000).getFullYear() : null))
        .filter((year) => Number.isFinite(year))
        .sort((a, b) => a - b);
    if (!years.length) return '—';
    return years.length === 1 ? String(years[0]) : `${years[0]}–${years[years.length - 1]}`;
}

function applyAlbum(data) {
    const name = data.owner.name || '匿名收藏家';
    const span = albumSpan(data.cards);
    const count = data.cards.length;
    const shared = Number.isFinite(data.sharedAt) ? data.sharedAt : data.updatedAt;

    $('plateMeta').textContent = `${count} 款 · ${span}`;
    $('pmDate').textContent = fmtShort(shared);
    $('pmYear').textContent = String(new Date(shared * 1000).getFullYear());

    $('regName').textContent = name;
    $('regCount').textContent = String(count);
    $('regSpan').textContent = span;

    const avatar = $('regAvatar');
    if (data.owner.avatar) {
        avatar.src = data.owner.avatar;
        avatar.hidden = false;
    } else {
        avatar.removeAttribute('src');
        avatar.hidden = true;
    }

    $('coverSpan').textContent = span;

    const barAvatar = $('barAvatar');
    if (data.owner.avatar) {
        barAvatar.src = data.owner.avatar;
        barAvatar.hidden = false;
    } else {
        barAvatar.removeAttribute('src');
        barAvatar.hidden = true;
    }
    $('barName').textContent = name;
    $('barMeta').textContent = `同步于 ${fmtDay(data.updatedAt)}`;

    const code = String(data.owner.friendCode ?? '').trim();
    $('friendBtn').hidden = !/^\d{1,10}$/.test(code);

    document.title = `${name} 的成就收藏册 · 借阅室`;
}

function resetViewFromAlbum() {
    const album = albumData?.album ?? {};
    view.perPage = Number(album.perPage) === 4 ? 4 : 1;
    view.years = album.yearPages === true;
    syncSettingsUI();
}

/** 快照里的顺序对应导出时的版面；访客改年份分页时按同一装订规则重排一次 */
function orderedCards() {
    if (!albumData) return [];
    const cards = albumData.cards;
    const snapshotYears = albumData.album?.yearPages === true;
    if (view.years === snapshotYears) return cards;
    return sortForBook(cards, albumData.album?.binding === 'newest' ? 'newest' : 'sequential', view.years);
}

function sortForBook(cards, binding, yearPages) {
    const newest = binding === 'newest';
    const compare = newest
        ? (a, b) => (b.completedAt ?? -1) - (a.completedAt ?? -1) || Number(a.appid) - Number(b.appid)
        : (a, b) => (a.completedAt ?? Infinity) - (b.completedAt ?? Infinity) || Number(a.appid) - Number(b.appid);
    if (!yearPages) return [...cards].sort(compare);
    const buckets = new Map();
    for (const card of cards) {
        const key = yearOf(card);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(card);
    }
    const keys = [...buckets.keys()].sort((a, b) => {
        if (a === 'unknown') return -1;
        if (b === 'unknown') return 1;
        return Number(a) - Number(b);
    });
    return keys.flatMap((key) => [...buckets.get(key)].sort(compare));
}

/* ── 状态面板 ─────────────────────────────────────────────────────────── */

const STATUS = {
    noToken: {
        title: '这是一份借阅邀请',
        text: '输入朋友发来的 9 位借阅码，或直接打开带码的链接。',
    },
    badToken: {
        title: '链接不完整',
        text: '看起来链接少了一截，请回到聊天窗口重新点开。',
    },
    gone: {
        title: '这本册子已经收回',
        text: '借阅码可能已经换新，或主人收回了这份只读副本。',
    },
    upgrade: {
        title: '借阅室需要更新',
        text: '这份快照比当前页面新，请稍后再来，或请主人重新分享一次。',
    },
    network: {
        title: '没能取回这本册子',
        text: '网络暂时不通。检查连接后可以再试一次。',
        action: '再试一次',
    },
    rate: {
        title: '查询太频繁',
        text: '同一网络短时间内找得太多了，稍等一会儿再试。',
        action: '再试一次',
    },
    empty: {
        title: '这本册子还是空的',
        text: '主人还没有把任何完美通关的游戏收进来。',
    },
};

function hideStatus() {
    statusPanel.classList.remove('on');
}

function hideCodePanel() {
    codePanel.classList.remove('on');
}

function showCodePanel(message) {
    hideStatus();
    mail.classList.remove('show');
    mail.setAttribute('aria-hidden', 'true');
    codePanel.classList.add('on');
    codeHint.textContent = message || '朋友发来的 9 位数字；也可以直接打开带 ?c= 的链接。';
    if (target?.kind === 'code') codeInput.value = groupCode(target.value);
    codeInput.focus({ preventScroll: true });
    codeInput.select?.();
}

function showStatus(kind) {
    const item = typeof kind === 'string' ? STATUS[kind] : kind;
    hideCodePanel();
    mail.classList.remove('show');
    mail.setAttribute('aria-hidden', 'true');
    statusPanel.classList.add('on');
    $('statusTitle').textContent = item.title;
    $('statusText').textContent = item.text;
    const row = $('statusActions');
    const btn = $('statusBtn');
    const make = $('statusMake');
    if (item.action) {
        row.hidden = false;
        btn.textContent = item.action;
        btn.onclick = item.onAction;
        btn.focus({ preventScroll: true });
    } else {
        row.hidden = true;
        btn.onclick = null;
    }
    // 只有「册子已合上」这类正常结束的界面才引导访客去装插件
    make.hidden = !item.more;
}

let codeErrorTimer = 0;
function showCodeError(message) {
    codeField.classList.remove('bad');
    void codeField.offsetWidth;
    codeField.classList.add('bad');
    codeHint.textContent = message;
    clearTimeout(codeErrorTimer);
    codeErrorTimer = setTimeout(() => codeField.classList.remove('bad'), 450);
    codeInput.focus({ preventScroll: true });
    codeInput.select?.();
}

function submitCode() {
    if (busy) return;
    const value = normalizeCode(codeInput.value);
    if (!CODE_RE.test(value)) {
        showCodeError('借阅码是 9 位数字，请再检查一下。');
        return;
    }
    target = { kind: 'code', value };
    const next = new URL(location.href);
    next.searchParams.delete('t');
    next.searchParams.set('c', value);
    history.replaceState(null, '', next);
    codeInput.value = groupCode(value);
    hideCodePanel();
    startBorrow();
}

/* ── 收信 ─────────────────────────────────────────────────────────────── */

function resetMail() {
    mail.className = 'rm-mail';
    seal.classList.remove('crack', 'brk', 'press');
    mark.classList.remove('on', 'set');
    canOpenBook = false;
    tip('');
}

async function flyAway() {
    const letterOut = mail.classList.contains('hv') || mail.classList.contains('big');
    mail.classList.remove('big', 'hv', 'ask');
    if (letterOut) await sleep(1000);
    mail.classList.remove('open');
    await sleep(560);
    seal.classList.remove('crack', 'brk');
    mail.classList.add('sealed');
    play(seal, 'press');
    await sleep(300);
    burst(mail, 14, '50%', '50%');
    play(ring, 'go');
    await sleep(650);
    mail.classList.add('away');
    await sleep(950);
    mail.className = 'rm-mail';
    seal.classList.remove('press');
}

function waitForSeal() {
    return new Promise((resolve) => {
        const done = () => {
            seal.removeEventListener('click', done);
            seal.removeEventListener('keydown', onKey);
            resolve();
        };
        const onKey = (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            done();
        };
        seal.addEventListener('click', done);
        seal.addEventListener('keydown', onKey);
    });
}

async function startBorrow({ cached = false } = {}) {
    if (busy || reading) return;
    if (!target) {
        showCodePanel();
        return;
    }
    const active = target;
    busy = true;
    hideStatus();
    hideCodePanel();
    resetMail();
    mail.removeAttribute('aria-hidden');

    const resultPromise = cached && albumData
        ? Promise.resolve({ data: albumData })
        : requestAlbum(active);

    mail.className = 'rm-mail show sealed arrive';
    await sleep(680);
    burst(mail, 12, '50%', '100%');
    play(ring, 'go');
    await sleep(430);
    mail.classList.remove('arrive');
    tip('正在取回册子…');

    const result = await resultPromise;
    if (!result.data) {
        tip('');
        seal.classList.add('crack');
        await sleep(260);
        seal.classList.add('brk');
        burst(mail, 16, '50%', '50%');
        await sleep(620);
        await flyAway();
        const kind = result.kind || 'network';
        const item = { ...(STATUS[kind] ?? STATUS.network) };
        if (active.kind === 'code' && kind === 'gone') {
            item.action = '换个借阅码';
            item.onAction = () => {
                target = null;
                showCodePanel('没有找到这本册子，请检查借阅码。');
            };
        } else if (item.action) {
            item.onAction = () => startBorrow();
        }
        showStatus(item);
        busy = false;
        return;
    }

    albumData = result.data;
    applyAlbum(albumData);
    resetViewFromAlbum();
    mark.classList.add('on', 'set');
    tip('轻点封蜡，拆开信件');
    await waitForSeal();

    tip('');
    seal.classList.add('crack');
    sound.cue('crack');
    await sleep(240);
    seal.classList.add('brk');
    sound.cue('break');
    burst(mail, 16, '50%', '50%');
    await sleep(720);

    mail.classList.remove('sealed');
    mail.classList.add('open');
    sound.cue('flap');
    await sleep(480);
    mail.classList.add('hv');
    sound.cue('slide');
    await sleep(880);
    mail.classList.add('big');
    await sleep(1050);

    mail.classList.add('ask');
    tip('轻点明信片，查看借阅登记卡');
    await once(letter);
    mail.classList.remove('ask');

    mail.classList.add('back');
    busy = false;
    canOpenBook = true;
    await sleep(700);
    tip('翻开册子，开始翻阅');
    openBookBtn.focus({ preventScroll: true });
}

/* ── 真实册子 ─────────────────────────────────────────────────────────── */

let book = null;

function bookOptions() {
    const album = albumData?.album ?? {};
    const binding = album.binding === 'newest' ? 'newest' : 'sequential';
    const coverOverrides = {};
    for (const card of albumData?.cards ?? []) {
        if (card.cover && (card.cover.front || card.cover.back)) coverOverrides[card.appid] = card.cover;
    }
    return {
        cards: orderedCards(),
        owner: { persona: albumData?.owner?.name ?? '', avatar: albumData?.owner?.avatar ?? '' },
        perPage: view.perPage,
        binding,
        showStats: album.showStats !== false,
        yearPages: view.years,
        yearSelections: albumData?.years ?? null,
        coverOverrides,
    };
}

function mountBook(initial = null) {
    if (book) return;
    setOptionProvider((name) => {
        if (name === '年份特殊页') return view.years ? '开启' : '关闭';
        return undefined;
    });
    book = createBook(bookHost, { ...bookOptions(), initial, readOnly: true });
}

function unmountBook() {
    book?.destroy();
    book = null;
    bookHost.replaceChildren();
}

function rebuildBook() {
    if (!reading || busy || !book) return;
    const position = book.position;
    unmountBook();
    mountBook(position);
}

function syncSettingsUI() {
    $('setPop').querySelectorAll('[data-per]').forEach((btn) => {
        btn.classList.toggle('on', Number(btn.dataset.per) === view.perPage);
    });
    const yearToggle = $('yearToggle');
    yearToggle.classList.toggle('on', view.years);
    yearToggle.setAttribute('aria-checked', String(view.years));
}

/**
 * 幕布上的假跨页直接克隆真实册子当前这一跨页，幕布淡出时真假两页重合。
 * 这段与 preview/borrow.html 的正式转场一致。
 */
function dressFakeSpread() {
    const newest = bookOptions().binding === 'newest';
    const leftNode = newest
        ? bookHost.querySelector('.ac-page--end')
        : bookHost.querySelector('.ac-page--title');
    const rightNode = newest
        ? bookHost.querySelector('.ac-leaf[data-show-back] .ac-leaf__face--back')
        : bookHost.querySelector('.ac-leaf[data-show-front] .ac-leaf__face--front');

    const leftHost = $('coverEnd');
    const rightHost = cover.querySelector('.rm-cover__inside');

    if (leftHost && leftNode) {
        const clone = leftNode.cloneNode(true);
        clone.classList.remove('ac-page--base');
        clone.style.inset = '0';
        leftHost.replaceChildren(clone);
    }
    if (rightHost && rightNode) {
        const clone = rightNode.cloneNode(true);
        rightHost.replaceChildren(clone);
    }
}

async function openBook() {
    if (reading || !canOpenBook) return;
    reading = true;
    busy = true;
    canOpenBook = false;
    tip('');
    mail.classList.remove('ask');
    sound.setBookOpen(true);

    mountBook();
    reader.classList.add('on', 'ceremony');
    reader.setAttribute('aria-hidden', 'true');

    const bookEl = bookHost.querySelector('.ac-book') ?? bookHost;
    const bookRect = bookEl.getBoundingClientRect();
    if (bookRect.width > 0) {
        cover.querySelector('.rm-cover__book').style.setProperty('--rm-cw', `${bookRect.width / 2}px`);
        const veilRect = veil.getBoundingClientRect();
        const dy = bookRect.top + bookRect.height / 2 - (veilRect.top + veilRect.height / 2);
        veil.style.paddingTop = `${Math.max(0, dy * 2)}px`;
    }
    dressFakeSpread();

    veil.classList.add('on');
    requestAnimationFrame(() => veil.classList.add('lit'));
    await sleep(1740);
    veil.classList.add('open');
    await sleep(1500);

    reader.style.transition = 'none';
    reader.classList.add('visible');
    void reader.offsetWidth;
    reader.style.transition = '';
    veil.classList.add('fade');
    await sleep(520);

    veil.classList.remove('on', 'lit', 'fade', 'open');
    veil.style.paddingTop = '';
    reader.classList.remove('ceremony');
    reader.setAttribute('aria-hidden', 'false');
    $('closeBtn').focus({ preventScroll: true });
    mail.setAttribute('aria-hidden', 'true');
    busy = false;
    toast('光标停在卡片上可以细看，滚轮或点击页面翻页');
}

async function closeReader() {
    if (!reading || busy) return;
    busy = true;
    $('setPop').hidden = true;
    $('setBtn').setAttribute('aria-expanded', 'false');
    const btn = $('closeBtn');
    btn.disabled = true;
    sound.setBookOpen(false);
    reader.classList.remove('visible');
    await sleep(560);
    unmountBook();
    reader.classList.remove('on');
    if (reader.contains(document.activeElement)) document.activeElement.blur();
    reader.setAttribute('aria-hidden', 'true');
    reading = false;
    canOpenBook = false;

    await sleep(260);
    mail.classList.remove('big', 'hv', 'back');
    await sleep(1000);
    await flyAway();
    showStatus({
        title: '册子已合上',
        text: '这份只读副本已经寄回给主人。',
        action: '再次借阅',
        more: true,
        onAction: () => {
            if (!busy) startBorrow({ cached: true });
        },
    });
    btn.disabled = false;
    busy = false;
}

/* ── 设置与事件 ───────────────────────────────────────────────────────── */

$('openBookBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    if (mail.classList.contains('back')) openBook();
});

letter.addEventListener('click', () => {
    if (!mail.classList.contains('back') || busy || reading || !canOpenBook) return;
    openBook();
});

$('closeBtn').addEventListener('click', closeReader);

$('setBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    const pop = $('setPop');
    pop.hidden = !pop.hidden;
    $('setBtn').setAttribute('aria-expanded', String(!pop.hidden));
    if (!pop.hidden) syncSettingsUI();
});
$('setPop').addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', () => {
    if ($('setPop').hidden) return;
    $('setPop').hidden = true;
    $('setBtn').setAttribute('aria-expanded', 'false');
});

$('setPop').querySelectorAll('[data-per]').forEach((btn) => {
    btn.addEventListener('click', () => {
        const next = Number(btn.dataset.per) === 4 ? 4 : 1;
        if (next === view.perPage) return;
        view.perPage = next;
        syncSettingsUI();
        rebuildBook();
    });
});

$('yearToggle').addEventListener('click', () => {
    view.years = !view.years;
    syncSettingsUI();
    rebuildBook();
});

$('friendBtn').addEventListener('click', async () => {
    const code = String(albumData?.owner?.friendCode ?? '').trim();
    if (!/^\d{1,10}$/.test(code)) return;
    const ok = await copyText(code);
    toast(ok ? '好友代码已复制' : '复制失败，请稍后再试');
});

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !reading) return;
    if (!$('setPop').hidden) {
        $('setPop').hidden = true;
        $('setBtn').setAttribute('aria-expanded', 'false');
        return;
    }
    closeReader();
});

// 只读册子不需要封面取景编辑器，右键只保留系统菜单之外的干净体验
bookHost.addEventListener('pointerdown', (event) => {
    if (event.button === 2) event.stopPropagation();
}, true);
bookHost.addEventListener('contextmenu', (event) => event.preventDefault());

/* ── 借阅码入口 ───────────────────────────────────────────────────────── */

$('codeBtn').addEventListener('click', submitCode);
codeInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitCode();
});
codeInput.addEventListener('input', () => codeField.classList.remove('bad'));

/* ── 启动 ─────────────────────────────────────────────────────────────── */

(async function boot() {
    sound.enter();
    room.style.opacity = '0';
    room.style.transition = 'opacity .6s ease';
    await sleep(30);
    room.style.opacity = '1';

    if (!target) {
        if (q.has('c')) {
            showCodePanel('借阅码是 9 位数字，请再检查一下。');
            codeInput.value = groupCode(rawCode);
        } else if (token) {
            showStatus('badToken');
        } else {
            showCodePanel();
        }
        return;
    }
    if (target.kind === 'token' && !TOKEN_RE.test(target.value)) {
        showStatus('badToken');
        return;
    }
    startBorrow();
})();

if (DEBUG) {
    window.__borrowRoom = {
        get album() { return albumData; },
        get book() { return book; },
        get view() { return { ...view }; },
        get target() { return target; },
        sound,
        startBorrow,
        openBook,
        closeReader,
    };
}
