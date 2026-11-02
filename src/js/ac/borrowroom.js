/**
 * 成就收藏册 · 借阅室（卡册页内的正式版）
 *
 * 同一间房里做两件事：
 *   寄信 —— 把当前册子做成冻结快照上传，拿到 9 位只读借阅码；
 *           上次的分享记在本机（ac:v1:share，按 accountId 分开），
 *           可以复制、同步最新、换新借阅码、收回。
 *   收信 —— 输入朋友发来的借阅码（或旧版借阅链接），取回快照，用主题真实的
 *           createBook 只读翻阅；阅读设置只影响这一次阅读。
 *
 * 隐私：快照里有昵称、头像和好友代码（即 accountId，朋友靠它加好友），没有登录信息；
 * 寄信记录只存在本机 localStorage。
 */

import { createBook } from './book.js';
import {
    MAX_SNAPSHOT_BYTES,
    API_BASE,
    buildSnapshot,
    clearShareRecord,
    codeViewerUrl,
    createAlbum,
    deleteAlbum,
    fetchAlbum,
    fetchAlbumByCode,
    fetchAlbumMeta,
    readAlbumSettings,
    readShareRecord,
    resolveShareOwner,
    serializeSnapshot,
    updateAlbum,
    writeShareRecord,
} from './share.js';
import { getState } from './store.js';
import { readYearSelections } from './cache.js';
import { loadBadge, peekBadgeUrl } from './badges.js';
import { copyText } from './clipboard.js';
import { ensureNodeStyles } from './env.js';
import { BORROW_ROOM_HTML } from './borrowmarkup.js';
import { createRoomSound } from './roomsound.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CODE_RE = /^\d{9}$/;
// 音乐放在分享服务器上：借阅室本来就要连它，房间能用就一定取得到音乐（部署见 share-server/Caddyfile）。
// build-plugin --local-music 会把音乐内嵌成 data: 地址，只用于本机验收
const ROOM_MUSIC_URL =
    (typeof __AC_ROOM_MUSIC__ === 'string' && __AC_ROOM_MUSIC__) || `${API_BASE}/audio/reading-room.mp3`;

const normalizeCode = (value) => String(value ?? '').replace(/[\s-]/g, '');
const groupCode = (value) => normalizeCode(value).replace(/(\d{3})(?=\d)/g, '$1 ').trim();

const nowSec = () => Math.floor(Date.now() / 1000);
const pad2 = (n) => String(n).padStart(2, '0');

function fmtDay(seconds) {
    const d = new Date(Number(seconds) * 1000);
    if (!Number.isFinite(d.getTime())) return '—';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtShort(seconds) {
    const d = new Date(Number(seconds) * 1000);
    if (!Number.isFinite(d.getTime())) return '—';
    return `${d.getMonth() + 1}.${d.getDate()}`;
}

function yearOf(card) {
    return Number.isFinite(card?.completedAt) ? String(new Date(card.completedAt * 1000).getFullYear()) : 'unknown';
}

function albumSpan(cards) {
    const years = (cards ?? [])
        .map((card) => (Number.isFinite(card?.completedAt) ? new Date(card.completedAt * 1000).getFullYear() : null))
        .filter((year) => Number.isFinite(year))
        .sort((a, b) => a - b);
    if (!years.length) return '—';
    return years.length === 1 ? String(years[0]) : `${years[0]}–${years[years.length - 1]}`;
}

function parseTarget(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    const bare = normalizeCode(text);
    if (CODE_RE.test(bare)) return { kind: 'code', value: bare };

    try {
        const params = new URL(text).searchParams;
        const code = normalizeCode(params.get('c') ?? '');
        if (CODE_RE.test(code)) return { kind: 'code', value: code };
        const token = params.get('t');
        if (token && TOKEN_RE.test(token)) return { kind: 'token', value: token };
    } catch {
        /* 不是完整链接，继续按口令处理 */
    }

    if (TOKEN_RE.test(text)) return { kind: 'token', value: text };
    const codeFromUrl = text.match(/[?&]c=(\d{9})(?:[&#\s]|$)/);
    if (codeFromUrl) return { kind: 'code', value: codeFromUrl[1] };
    const tokenFromUrl = text.match(/[?&]t=([A-Za-z0-9_-]{16,64})/);
    return tokenFromUrl ? { kind: 'token', value: tokenFromUrl[1] } : null;
}

function isSteamAvatar(value) {
    return typeof value === 'string' && /^https:\/\/[^/]+\.steamstatic\.com\//.test(value);
}

function validSnapshot(data) {
    return Boolean(
        data &&
            data.kind === 'achievement-album' &&
            Number(data.schemaVersion) === 1 &&
            data.owner &&
            Array.isArray(data.cards),
    );
}

function firstLine(message) {
    return String(message ?? '').split('\n')[0].trim();
}

/**
 * 打开借阅室。返回 { destroy, close }：destroy 立即拆掉（页面卸载时用），
 * close 走淡出并允许触发 onClosed（页面用它重装主册，清掉只读册留下的取景覆盖）。
 */
export function openBorrowRoom({ doc, trigger = null, onClosed = null, musicSrc = ROOM_MUSIC_URL } = {}) {
    if (!doc?.body) throw new Error('借阅室需要一个可挂载的文档');
    const win = doc.defaultView ?? window;
    const reduceMotion = win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    const SPEED = reduceMotion ? 0.14 : 1;
    const sleep = (ms) => new Promise((resolve) => win.setTimeout(resolve, ms * SPEED));

    const root = doc.createElement('div');
    root.className = 'rm-root ac-borrow';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '借阅室');
    root.innerHTML = BORROW_ROOM_HTML;
    doc.body.append(root);
    ensureNodeStyles(root);

    const $ = (id) => root.querySelector(`#${id}`);
    const stage = root.querySelector('.rm-stage');
    const room = root.querySelector('.rm-room');
    const mail = $('acBorrowMail');
    const letter = $('acBorrowLetter');
    const seal = $('acBorrowSeal');
    const ring = $('acBorrowRing');
    const veil = $('acBorrowVeil');
    const cover = $('acBorrowCover');
    const reader = $('acBorrowReader');
    const bookHost = $('acBorrowBookHost');
    const rack = $('acBorrowRack');
    const stamp = $('acBorrowStamp');
    const stampBox = $('acBorrowStampBox');
    const result = $('acBorrowResult');
    const resultTitle = $('acBorrowResultTitle');
    const resultNote = $('acBorrowResultNote');
    const codeOut = $('acBorrowCodeOut');
    const codeNote = $('acBorrowCodeNote');
    const linkInput = $('acBorrowLink');
    const field = $('acBorrowField');
    const borrowBtn = $('acBorrowBorrow');
    const copyBtn = $('acBorrowCopy');
    const copyLinkBtn = $('acBorrowCopyLink');
    const syncBtn = $('acBorrowSync');
    const renewBtn = $('acBorrowRenew');
    const revokeBtn = $('acBorrowRevoke');
    const mark = $('acBorrowMark');
    const openBookBtn = $('acBorrowOpenBook');
    const closeBtn = $('acBorrowCloseBtn');
    const setBtn = $('acBorrowSetBtn');
    const setPop = $('acBorrowSetPop');
    const yearToggle = $('acBorrowYearToggle');
    const friendBtn = $('acBorrowFriend');
    const codePop = $('acBorrowCodePop');
    const codeValue = $('acBorrowCodeValue');
    const codeCopy = $('acBorrowCodeCopy');
    const codeHint = $('acBorrowCodeHint');
    const tipNode = $('acBorrowTip');
    const toastNode = $('acBorrowToast');
    const exitBtn = $('acBorrowExit');
    const sound = createRoomSound({ doc, button: $('acBorrowSound'), src: musicSrc });

    const tabButtons = [...root.querySelectorAll('.rm-seg button')];

    let destroyed = false;
    let closing = false;
    let busy = false;
    let sending = false;
    let reading = false;
    let canOpenBook = false;
    let mode = 'out';
    let opSeq = 0;
    let albumData = null;
    let owner = null;
    let sendRecord = null;
    let resultCode = '';
    let resultUrl = '';
    let borrowedAnything = false;
    let book = null;
    let toastTimer = 0;
    let confirmTimer = 0;
    let armedButton = null;
    let drag = null;

    const view = { perPage: 1, years: false };

    /* ── 小工具 ─────────────────────────────────────────────────────────── */

    function toast(text, ms = 2400) {
        toastNode.textContent = String(text ?? '');
        toastNode.classList.add('on');
        win.clearTimeout(toastTimer);
        toastTimer = win.setTimeout(() => toastNode.classList.remove('on'), ms);
    }

    function tip(text) {
        tipNode.textContent = text || '';
        tipNode.classList.toggle('on', Boolean(text));
    }

    function burst(host, count, x, y) {
        for (let i = 0; i < count; i += 1) {
            const dot = doc.createElement('i');
            dot.className = 'rm-dust';
            const angle = Math.random() * 6.283;
            const dist = 1.4 + Math.random() * 4;
            dot.style.cssText = `left:${x};top:${y};--x:${(Math.cos(angle) * dist * 1.4).toFixed(2)}em;--y:${(Math.sin(angle) * dist - 1).toFixed(2)}em;animation-delay:${(Math.random() * 0.1).toFixed(2)}s`;
            host.appendChild(dot);
            win.setTimeout(() => dot.remove(), 1200);
        }
    }

    function play(node, cls) {
        node.classList.remove(cls);
        void node.offsetWidth;
        node.classList.add(cls);
    }

    function once(node, type = 'click') {
        return new Promise((resolve) => node.addEventListener(type, resolve, { once: true }));
    }

    function setLobby(visible) {
        $('acBorrowPanelIn').classList.toggle('on', Boolean(visible));
    }

    function closeSetPop() {
        if (!setPop.hidden) setPop.hidden = true;
        setBtn.setAttribute('aria-expanded', 'false');
    }

    function closeCodePop() {
        if (!codePop.hidden) codePop.hidden = true;
        friendBtn.setAttribute('aria-expanded', 'false');
    }

    function setAvatar(img, value) {
        if (isSteamAvatar(value)) {
            img.src = value;
            img.hidden = false;
        } else {
            img.removeAttribute('src');
            img.hidden = true;
        }
    }

    /* ── 登记卡 / 封面 / 阅读条 ─────────────────────────────────────────── */

    function applyView(data) {
        const person = data.owner ?? {};
        const name = String(person.name ?? person.persona ?? '').trim() || '匿名收藏家';
        const count = Number(data.count ?? 0);
        const span = data.span ?? '—';
        const shared = Number.isFinite(data.sharedAt) ? data.sharedAt : nowSec();
        const updated = Number.isFinite(data.updatedAt) ? data.updatedAt : shared;

        $('acBorrowPlateMeta').textContent = `${count} 款 · ${span}`;
        $('acBorrowPmDate').textContent = fmtShort(shared);
        $('acBorrowPmYear').textContent = String(new Date(shared * 1000).getFullYear());

        $('acBorrowRegName').textContent = name;
        $('acBorrowRegCount').textContent = String(count);
        $('acBorrowRegSpan').textContent = span;
        setAvatar($('acBorrowRegAvatar'), person.avatar);

        $('acBorrowCoverSpan').textContent = span;

        setAvatar($('acBorrowBarAvatar'), person.avatar);
        $('acBorrowBarName').textContent = name;
        $('acBorrowBarMeta').textContent = `分享于 ${fmtDay(shared)} · 同步于 ${fmtDay(updated)}`;

        const friendCode = String(person.friendCode ?? '').trim();
        friendBtn.hidden = !/^\d{1,10}$/.test(friendCode);
        if (friendBtn.hidden) closeCodePop();
    }

    function viewForCards(cards, person) {
        const now = nowSec();
        return {
            owner: person ?? {},
            count: cards.length,
            span: albumSpan(cards),
            sharedAt: now,
            updatedAt: now,
        };
    }

    function viewForSnapshot(data) {
        const shared = Number.isFinite(data.sharedAt) ? data.sharedAt : Number(data.updatedAt) || nowSec();
        return {
            owner: data.owner,
            count: data.cards.length,
            span: albumSpan(data.cards),
            sharedAt: shared,
            updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : shared,
        };
    }

    function resetViewFromAlbum() {
        const album = albumData?.album ?? {};
        view.perPage = Number(album.perPage) === 4 ? 4 : 1;
        view.years = album.yearPages === true;
        syncSettingsUI();
    }

    /* ── 信封 ───────────────────────────────────────────────────────────── */

    function resetMail() {
        mail.className = 'rm-mail';
        mail.setAttribute('aria-hidden', 'true');
        seal.classList.remove('crack', 'brk', 'press');
        rack.classList.remove('on');
        mark.classList.remove('on', 'set');
        stamp.style.transform = '';
        stamp.style.transition = '';
        drag = null;
        canOpenBook = false;
        tip('');
    }

    function hideResult() {
        result.classList.remove('on');
        resetConfirm();
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
        mail.setAttribute('aria-hidden', 'true');
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

    /* ── 寄信 ───────────────────────────────────────────────────────────── */

    async function prepareSend() {
        if (destroyed || mode !== 'out' || reading) return;
        const gen = ++opSeq;
        hideResult();
        resetMail();
        setLobby(false);
        tip('正在准备寄信…');

        const cards = getState()?.cards ?? [];
        const person = await resolveShareOwner();
        if (destroyed || gen !== opSeq || mode !== 'out') return;
        if (!person?.accountId) {
            tip('没能确认当前 Steam 账号，请稍后再试');
            return;
        }
        owner = person;
        applyView(viewForCards(cards, person));

        if (!cards.length) {
            prepLend();
            tip('册子还是空的，先收几款全成就游戏吧');
            return;
        }

        const record = readShareRecord(person.accountId);
        if (!record?.token || !record?.editKey) {
            prepLend();
            return;
        }

        tip('正在核对上次的分享…');
        try {
            const [data, meta] = await Promise.all([
                fetchAlbum(record.token),
                fetchAlbumMeta(record.token, record.editKey).catch(() => null),
            ]);
            if (destroyed || gen !== opSeq || mode !== 'out') return;
            if (!validSnapshot(data)) throw new Error('上次的分享数据不完整。');
            const code = normalizeCode(meta?.code ?? record.code ?? '');
            sendRecord = {
                ...record,
                code: CODE_RE.test(code) ? code : record.code,
                url: meta?.url || record.url,
                sharedAt: Number.isFinite(data.sharedAt) ? data.sharedAt : record.sharedAt,
                updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : record.updatedAt,
                revision: Number.isFinite(data.revision) ? data.revision : record.revision,
            };
            writeShareRecord(person.accountId, sendRecord);
            showResult('已寄出的借阅码', sendRecord);
        } catch (err) {
            if (destroyed || gen !== opSeq || mode !== 'out') return;
            if (err?.status === 404) {
                clearShareRecord(person.accountId);
                sendRecord = null;
                prepLend();
                toast('上次的分享已失效，请重新寄一封');
                return;
            }
            sendRecord = record;
            showResult(
                '已寄出的借阅码',
                record,
                '暂时没能核对上次的分享；网络恢复后可以点「同步最新」。',
            );
        }
    }

    function showResult(title, record, note) {
        resetMail();
        setLobby(false);
        const code = normalizeCode(record.code ?? '');
        const hasCode = CODE_RE.test(code);
        resultCode = hasCode ? code : '';
        resultUrl = hasCode ? codeViewerUrl(code) : '';
        resultTitle.textContent = title;
        codeOut.textContent = hasCode ? groupCode(code) : '— — —';
        codeOut.classList.toggle('empty', !hasCode);
        codeNote.textContent = hasCode
            ? '把 9 位借阅码发给朋友，对方在借阅室「收信」里输入即可。'
            : '这条分享还没有借阅码，联网后点「同步最新」再试。';
        resultNote.textContent =
            note || `同步于 ${fmtDay(record.updatedAt)} · 换新借阅码后，旧的码和链接都会作废。`;
        result.classList.add('on');
        resetConfirm();
        setManageDisabled(false);
        copyBtn.disabled = !hasCode;
        copyLinkBtn.disabled = !hasCode;
        (hasCode ? copyBtn : syncBtn).focus({ preventScroll: true });
    }

    function prepLend() {
        hideResult();
        resetMail();
        setLobby(false);
        const cards = getState()?.cards ?? [];
        applyView(viewForCards(cards, owner));
        openBookBtn.hidden = true;
        mail.className = 'rm-mail show open hv back';
        mail.removeAttribute('aria-hidden');
        mail.classList.add('arrive');
        rack.classList.add('on');
        tip('拖动印章盖在登记卡上，也可以直接点击印章');
        win.setTimeout(() => mail.classList.remove('arrive'), 1000 * SPEED);
        stamp.focus({ preventScroll: true });
    }

    function setManageDisabled(disabled) {
        copyBtn.disabled = Boolean(disabled) || !resultCode;
        copyLinkBtn.disabled = Boolean(disabled) || !resultUrl;
        syncBtn.disabled = Boolean(disabled);
        renewBtn.disabled = Boolean(disabled);
        revokeBtn.disabled = Boolean(disabled);
        exitBtn.disabled = Boolean(disabled) && sending;
    }

    function resetConfirm() {
        win.clearTimeout(confirmTimer);
        if (armedButton) {
            armedButton.dataset.armed = '0';
            armedButton.classList.remove('confirm');
            armedButton.textContent = armedButton === revokeBtn ? '收回' : '换新借阅码';
        }
        armedButton = null;
    }

    function armConfirm(button, label, action) {
        if (button.dataset.armed === '1') {
            resetConfirm();
            action();
            return;
        }
        resetConfirm();
        armedButton = button;
        button.dataset.armed = '1';
        button.classList.add('confirm');
        button.textContent = label;
        button.focus({ preventScroll: true });
        confirmTimer = win.setTimeout(resetConfirm, 3200);
    }

    /** 年份页徽章图案要先取回来，访客的浏览器才看得到（最多等 2.2 秒） */
    async function warmBadgeArt(yearSelections) {
        const missing = [];
        for (const selection of Object.values(yearSelections ?? {})) {
            for (const picked of selection?.badges ?? []) {
                const appid = Number(picked?.appid);
                if (!picked || picked.level === 'cover' || !Number.isFinite(appid)) continue;
                if (!peekBadgeUrl(appid, picked.level) && !missing.includes(appid)) missing.push(appid);
            }
        }
        if (!missing.length) return;
        await Promise.race([
            Promise.all(missing.map((appid) => loadBadge(appid).catch(() => null))),
            sleep(2200),
        ]);
    }

    async function buildCurrentSnapshot() {
        const cards = getState()?.cards ?? [];
        if (!cards.length) throw new Error('这本册子还是空的，先收几款全成就游戏吧。');
        if (!owner?.accountId) throw new Error('没能确认当前 Steam 账号，请稍后再试。');
        const yearSelections = readYearSelections();
        await warmBadgeArt(yearSelections);
        const doc_ = buildSnapshot({
            cards,
            owner,
            album: readAlbumSettings(),
            yearSelections,
        });
        const { bytes } = serializeSnapshot(doc_);
        if (bytes > MAX_SNAPSHOT_BYTES) {
            throw new Error(`快照有 ${(bytes / 1024).toFixed(0)} KB，超过 ${MAX_SNAPSHOT_BYTES / 1024} KB 上限。`);
        }
        return { doc: doc_, cards };
    }

    function recordFromCreate(res, previous = null) {
        const code = normalizeCode(res.code ?? previous?.code ?? '');
        return {
            token: res.token,
            editKey: res.editKey,
            code: CODE_RE.test(code) ? code : '',
            url: res.url || (CODE_RE.test(code) ? codeViewerUrl(code) : ''),
            sharedAt: Number.isFinite(res.sharedAt) ? res.sharedAt : previous?.sharedAt ?? nowSec(),
            updatedAt: Number.isFinite(res.updatedAt) ? res.updatedAt : nowSec(),
            revision: Number.isFinite(res.revision) ? res.revision : 1,
        };
    }

    function describeSendError(err, action = 'update') {
        if (err?.status === 403) return '编辑凭证已失效，请换一个新的借阅码。';
        if (err?.status === 404) {
            return action === 'create'
                ? '分享服务器还没有准备好（404），请稍后再试。'
                : '这条分享已经不在服务器上，请换一个新的借阅码。';
        }
        if (err?.status === 413) return '快照太大，服务器装不下。';
        if (err?.status === 429) return '操作太频繁，请稍后再试。';
        return firstLine(err?.message) || '没能连上分享服务器，请稍后再试。';
    }

    async function doStamp(fromDx = 0, fromDy = 0) {
        if (busy || destroyed || mode !== 'out' || !rack.classList.contains('on')) return;
        busy = true;
        tip('');

        const stampRect = stamp.getBoundingClientRect();
        const targetRect = stampBox.getBoundingClientRect();
        const tx = targetRect.left + targetRect.width / 2 - (stampRect.left + stampRect.width / 2);
        const ty = targetRect.top + targetRect.height / 2 - (stampRect.top + stampRect.height / 2);

        const opts = { easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' };
        stamp.animate(
            [
                { transform: `translate(${fromDx}px, ${fromDy}px) scale(1)` },
                { transform: `translate(${tx}px, ${ty - 12}px) scale(1.22)` },
            ],
            { ...opts, duration: 320 * SPEED },
        );
        await sleep(320);
        if (destroyed) return;

        stamp.animate(
            [
                { transform: `translate(${tx}px, ${ty - 12}px) scale(1.22)` },
                { transform: `translate(${tx}px, ${ty}px) scale(0.96)` },
            ],
            { ...opts, duration: 120 * SPEED, easing: 'cubic-bezier(.6,0,1,1)' },
        );
        await sleep(120);
        if (destroyed) return;

        stamp.style.transform = `translate(${tx}px, ${ty}px) scale(.96)`;
        stamp.classList.remove('dragging');
        mark.classList.add('on');
        stage.animate(
            [
                { transform: 'translate(0,0)' },
                { transform: 'translate(-3px,2px)' },
                { transform: 'translate(3px,-2px)' },
                { transform: 'translate(0,0)' },
            ],
            { duration: 260 * SPEED },
        );
        const stageRect = stage.getBoundingClientRect();
        const markRect = mark.getBoundingClientRect();
        burst(
            stage,
            8,
            `${markRect.left - stageRect.left + markRect.width / 2}px`,
            `${markRect.top - stageRect.top + markRect.height / 2}px`,
        );
        await sleep(380);
        if (destroyed) return;

        stamp.getAnimations().forEach((anim) => anim.cancel());
        stamp.style.transform = '';
        rack.classList.remove('on');
        await sleep(200);
        if (destroyed) return;

        let request;
        try {
            const { doc: snapshot } = await buildCurrentSnapshot();
            sending = true;
            exitBtn.disabled = true;
            tip('正在寄出…');
            request = createAlbum(snapshot);
        } catch (err) {
            busy = false;
            resetMail();
            prepLend();
            toast(describeSendError(err));
            return;
        }

        mail.classList.remove('back');
        await sleep(1000);

        let record;
        try {
            record = recordFromCreate(await request);
        } catch (err) {
            sending = false;
            busy = false;
            exitBtn.disabled = false;
            if (destroyed) return;
            resetMail();
            prepLend();
            toast(describeSendError(err, 'create'));
            return;
        }
        sending = false;
        exitBtn.disabled = false;
        if (destroyed) return;

        writeShareRecord(owner.accountId, record);
        sendRecord = record;
        await flyAway();
        if (destroyed) return;
        showResult('借阅码已生成', record);
        toast('借阅码已生成，复制后发给朋友吧');
        busy = false;
    }

    /* 印章拖拽 */
    stamp.addEventListener('pointerdown', (event) => {
        if (busy || mode !== 'out' || !rack.classList.contains('on')) return;
        const rect = stamp.getBoundingClientRect();
        drag = {
            x: event.clientX,
            y: event.clientY,
            cx: rect.left + rect.width / 2,
            cy: rect.top + rect.height / 2,
            dx: 0,
            dy: 0,
            moved: 0,
        };
        stamp.setPointerCapture(event.pointerId);
        stamp.style.transition = 'none';
        stamp.classList.add('dragging');
    });

    stamp.addEventListener('pointermove', (event) => {
        if (!drag) return;
        drag.dx = event.clientX - drag.x;
        drag.dy = event.clientY - drag.y;
        drag.moved = Math.max(drag.moved, Math.hypot(drag.dx, drag.dy));
        stamp.style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
    });

    function endDrag(event) {
        if (!drag) return;
        const state = drag;
        drag = null;
        stamp.releasePointerCapture?.(event.pointerId);

        const box = letter.getBoundingClientRect();
        const px = state.cx + state.dx;
        const py = state.cy + state.dy;
        const inLetter = px > box.left && px < box.right && py > box.top && py < box.bottom;

        if (state.moved < 6 || inLetter) {
            doStamp(state.dx, state.dy);
            return;
        }
        stamp.classList.remove('dragging');
        stamp.style.transition = 'transform .45s cubic-bezier(.3,1.5,.4,1)';
        stamp.style.transform = '';
        win.setTimeout(() => {
            stamp.style.transition = '';
        }, 460);
    }

    stamp.addEventListener('pointerup', endDrag);
    stamp.addEventListener('pointercancel', endDrag);
    stamp.addEventListener('click', () => {
        if (!drag && !busy && mode === 'out' && rack.classList.contains('on')) doStamp(0, 0);
    });
    stamp.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (!busy && mode === 'out' && rack.classList.contains('on')) doStamp(0, 0);
        }
    });

    /* ── 借阅码管理 ─────────────────────────────────────────────────────── */

    async function syncLatest() {
        if (busy || destroyed || !sendRecord) return;
        busy = true;
        sending = true;
        exitBtn.disabled = true;
        setManageDisabled(true);
        try {
            const { doc: snapshot, cards } = await buildCurrentSnapshot();
            const res = await updateAlbum(sendRecord.token, sendRecord.editKey, snapshot);
            if (destroyed) return;
            const code = normalizeCode(res?.code ?? sendRecord.code ?? '');
            sendRecord = {
                ...sendRecord,
                code: CODE_RE.test(code) ? code : sendRecord.code,
                url: res?.url || (CODE_RE.test(code) ? codeViewerUrl(code) : sendRecord.url),
                sharedAt: Number.isFinite(res?.sharedAt) ? res.sharedAt : sendRecord.sharedAt,
                updatedAt: Number.isFinite(res?.updatedAt) ? res.updatedAt : nowSec(),
                revision: Number.isFinite(res?.revision) ? res.revision : (sendRecord.revision ?? 1) + 1,
            };
            writeShareRecord(owner.accountId, sendRecord);
            showResult('已寄出的借阅码', sendRecord, `已同步 ${cards.length} 款 · ${fmtDay(sendRecord.updatedAt)} · 朋友输入借阅码会看到这一版只读快照。`);
            toast('已同步为最新版');
        } catch (err) {
            if (destroyed) return;
            if (err?.status === 403 || err?.status === 404) {
                clearShareRecord(owner.accountId);
                sendRecord = null;
                resetMail();
                prepLend();
                toast('上次的分享已失效，请重新盖一次章');
            } else {
                toast(describeSendError(err));
                setManageDisabled(false);
            }
        } finally {
            if (!destroyed) {
                busy = false;
                sending = false;
                exitBtn.disabled = false;
                setManageDisabled(false);
            }
        }
    }

    async function renewLink() {
        if (busy || destroyed || !sendRecord) return;
        busy = true;
        sending = true;
        exitBtn.disabled = true;
        setManageDisabled(true);
        let next = null;
        try {
            const { doc: snapshot, cards } = await buildCurrentSnapshot();
            const res = await createAlbum(snapshot);
            if (destroyed) return;
            next = recordFromCreate(res, sendRecord);
            writeShareRecord(owner.accountId, next);
            let revoked = true;
            try {
                await deleteAlbum(sendRecord.token, sendRecord.editKey);
            } catch {
                revoked = false;
            }
            sendRecord = next;
            showResult('借阅码已生成', next, `已同步 ${cards.length} 款 · ${fmtDay(next.updatedAt)} · 朋友输入新借阅码会看到这一版只读快照。`);
            toast(revoked ? '新借阅码已生成，旧的码和链接已收回' : '新借阅码已生成，但旧分享没能收回');
        } catch (err) {
            if (destroyed) return;
            toast(describeSendError(err));
            setManageDisabled(false);
        } finally {
            if (!destroyed) {
                busy = false;
                sending = false;
                exitBtn.disabled = false;
                setManageDisabled(false);
            }
        }
    }

    async function revokeLink() {
        if (busy || destroyed || !sendRecord) return;
        busy = true;
        sending = true;
        exitBtn.disabled = true;
        setManageDisabled(true);
        try {
            try {
                await deleteAlbum(sendRecord.token, sendRecord.editKey);
            } catch (err) {
                if (err?.status !== 404) throw err;
            }
            if (destroyed) return;
            clearShareRecord(owner.accountId);
            sendRecord = null;
            resetMail();
            prepLend();
            toast('已收回，旧借阅码和链接不再可用');
        } catch (err) {
            if (destroyed) return;
            toast(describeSendError(err));
            setManageDisabled(false);
        } finally {
            if (!destroyed) {
                busy = false;
                sending = false;
                exitBtn.disabled = false;
                setManageDisabled(false);
            }
        }
    }

    /* ── 收信 ───────────────────────────────────────────────────────────── */

    function describeBorrowError(err, kind = 'token') {
        if (err?.status === 404) {
            return kind === 'code' ? '没有找到这本册子，请检查借阅码。' : '这本册子已经收回，或链接有误。';
        }
        if (err?.code === 'network_error') return '网络暂时不通，没能取回册子。';
        if (err?.status === 429) return '取信太频繁，请稍后再试。';
        return firstLine(err?.message) || '没能取回这本册子。';
    }

    async function failBorrow(err, kind = 'token') {
        tip('');
        seal.classList.add('crack');
        await sleep(260);
        if (destroyed) return;
        seal.classList.add('brk');
        burst(mail, 16, '50%', '50%');
        await sleep(620);
        if (destroyed) return;
        await flyAway();
        if (destroyed) return;
        resetMail();
        setLobby(true);
        busy = false;
        toast(describeBorrowError(err, kind));
        linkInput.focus({ preventScroll: true });
        linkInput.select?.();
    }

    function shakeField() {
        play(field, 'bad');
        win.setTimeout(() => field.classList.remove('bad'), 400);
    }

    async function startBorrow(raw) {
        if (busy || reading || destroyed) return;
        const target = parseTarget(raw);
        if (!target) {
            shakeField();
            toast('借阅码或链接无效，请检查后重试');
            linkInput.focus({ preventScroll: true });
            return;
        }
        if (target.kind === 'code') linkInput.value = groupCode(target.value);

        busy = true;
        hideResult();
        setLobby(false);
        resetMail();
        mail.removeAttribute('aria-hidden');

        const request = target.kind === 'code' ? fetchAlbumByCode(target.value) : fetchAlbum(target.value);
        const resultPromise = request.then(
            (data) => ({ data }),
            (err) => ({ err }),
        );

        mail.className = 'rm-mail show sealed arrive';
        await sleep(680);
        if (destroyed) return;
        burst(mail, 12, '50%', '100%');
        play(ring, 'go');
        await sleep(430);
        if (destroyed) return;
        mail.classList.remove('arrive');
        tip('正在取回册子…');

        const { data, err } = await resultPromise;
        if (destroyed) return;
        if (err) {
            await failBorrow(err, target.kind);
            return;
        }
        if (Number(data?.schemaVersion) > 1) {
            await failBorrow(new Error('这份快照比当前版本新，请升级后再看。'), target.kind);
            return;
        }
        if (!validSnapshot(data)) {
            await failBorrow(new Error('这本册子的数据不完整。'), target.kind);
            return;
        }
        if (!data.cards.length) {
            await failBorrow(new Error('这本册子还是空的。'), target.kind);
            return;
        }

        albumData = data;
        applyView(viewForSnapshot(data));
        resetViewFromAlbum();
        mark.classList.add('on', 'set');
        openBookBtn.hidden = false;
        tip('轻点封蜡，拆开信件');
        await waitForSeal();
        if (destroyed) return;

        tip('');
        seal.classList.add('crack');
        sound.cue('crack');
        await sleep(240);
        if (destroyed) return;
        seal.classList.add('brk');
        sound.cue('break');
        burst(mail, 16, '50%', '50%');
        await sleep(720);
        if (destroyed) return;

        mail.classList.remove('sealed');
        mail.classList.add('open');
        sound.cue('flap');
        await sleep(480);
        if (destroyed) return;
        mail.classList.add('hv');
        sound.cue('slide');
        await sleep(880);
        if (destroyed) return;
        mail.classList.add('big');
        await sleep(1050);
        if (destroyed) return;

        mail.classList.add('ask');
        tip('轻点明信片，查看借阅登记卡');
        await once(letter);
        if (destroyed) return;
        mail.classList.remove('ask');

        mail.classList.add('back');
        busy = false;
        canOpenBook = true;
        await sleep(700);
        if (destroyed) return;
        tip('翻开册子，开始翻阅');
        openBookBtn.focus({ preventScroll: true });
    }

    /* ── 只读册子 ───────────────────────────────────────────────────────── */

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

    function orderedCards() {
        if (!albumData) return [];
        const snapshotYears = albumData.album?.yearPages === true;
        if (view.years === snapshotYears) return albumData.cards;
        return sortForBook(
            albumData.cards,
            albumData.album?.binding === 'newest' ? 'newest' : 'sequential',
            view.years,
        );
    }

    function bookOptions() {
        const album = albumData?.album ?? {};
        const coverOverrides = {};
        for (const card of albumData?.cards ?? []) {
            if (card.cover && (card.cover.front || card.cover.back)) coverOverrides[card.appid] = card.cover;
        }
        return {
            cards: orderedCards(),
            owner: { persona: albumData?.owner?.name ?? '', avatar: albumData?.owner?.avatar ?? '' },
            perPage: view.perPage,
            binding: album.binding === 'newest' ? 'newest' : 'sequential',
            showStats: album.showStats !== false,
            yearPages: view.years,
            yearSelections: albumData?.years ?? null,
            coverOverrides,
        };
    }

    function mountBook(initial = null) {
        if (book) return;
        book = createBook(bookHost, { ...bookOptions(), initial, readOnly: true });
        borrowedAnything = true;
    }

    function unmountBook() {
        if (!book) return;
        book.destroy();
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
        setPop.querySelectorAll('[data-per]').forEach((btn) => {
            btn.classList.toggle('on', Number(btn.dataset.per) === view.perPage);
        });
        yearToggle.classList.toggle('on', view.years);
        yearToggle.setAttribute('aria-checked', String(view.years));
    }

    function dressFakeSpread() {
        const newest = bookOptions().binding === 'newest';
        const leftNode = newest
            ? bookHost.querySelector('.ac-page--end')
            : bookHost.querySelector('.ac-page--title');
        const rightNode = newest
            ? bookHost.querySelector('.ac-leaf[data-show-back] .ac-leaf__face--back')
            : bookHost.querySelector('.ac-leaf[data-show-front] .ac-leaf__face--front');

        const leftHost = $('acBorrowCoverEnd');
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
        if (reading || busy || !canOpenBook || destroyed) return;
        reading = true;
        busy = true;
        canOpenBook = false;
        // 上一次合上时按钮被禁用过；不在这里复位，第二次借阅就会一直是灰的
        closeBtn.disabled = false;
        closeCodePop();
        tip('');
        mail.classList.remove('ask');
        exitBtn.hidden = true;
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
        win.requestAnimationFrame(() => veil.classList.add('lit'));
        await sleep(1740);
        if (destroyed) return;
        veil.classList.add('open');
        await sleep(1500);
        if (destroyed) return;

        reader.style.transition = 'none';
        reader.classList.add('visible');
        void reader.offsetWidth;
        reader.style.transition = '';
        veil.classList.add('fade');
        await sleep(520);
        if (destroyed) return;

        veil.classList.remove('on', 'lit', 'fade', 'open');
        veil.style.paddingTop = '';
        reader.classList.remove('ceremony');
        reader.setAttribute('aria-hidden', 'false');
        closeBtn.focus({ preventScroll: true });
        mail.setAttribute('aria-hidden', 'true');
        busy = false;
        toast('光标停在卡片上可以细看，滚轮或点击页面翻页');
    }

    async function closeReader() {
        if (!reading || busy || destroyed) return;
        busy = true;
        closeSetPop();
        closeCodePop();
        closeBtn.disabled = true;
        sound.setBookOpen(false);
        reader.classList.remove('visible');
        await sleep(560);
        if (destroyed) return;
        unmountBook();
        reader.classList.remove('on');
        if (reader.contains(doc.activeElement)) doc.activeElement.blur();
        reader.setAttribute('aria-hidden', 'true');
        reading = false;
        canOpenBook = false;

        await sleep(260);
        if (destroyed) return;
        mail.classList.remove('big', 'hv', 'back');
        await sleep(1000);
        if (destroyed) return;
        await flyAway();
        if (destroyed) return;

        exitBtn.hidden = false;
        resetMail();
        setLobby(true);
        busy = false;
        toast('已寄回，欢迎下次再来');
        borrowBtn.focus({ preventScroll: true });
    }

    /* ── 模式 ───────────────────────────────────────────────────────────── */

    function setMode(next) {
        if (busy || reading || destroyed || next === mode) return;
        opSeq += 1;
        resetConfirm();
        closeSetPop();
        closeCodePop();
        mode = next;
        tabButtons.forEach((btn) => {
            const on = btn.dataset.mode === mode;
            btn.classList.toggle('on', on);
            btn.setAttribute('aria-selected', String(on));
        });
        hideResult();
        resetMail();
        if (mode === 'in') {
            setLobby(true);
            tip('');
            linkInput.focus({ preventScroll: true });
        } else {
            prepareSend();
        }
    }

    /* ── 退出 ───────────────────────────────────────────────────────────── */

    function focusables() {
        return [...root.querySelectorAll('button, input, [tabindex="0"]')].filter((node) => {
            if (node.disabled || node.hidden) return false;
            if (node.closest('[aria-hidden="true"]')) return false;
            if (node.closest('[hidden]')) return false;
            return node.getClientRects().length > 0;
        });
    }

    function onKeyDown(event) {
        if (destroyed) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!codePop.hidden) {
                closeCodePop();
                friendBtn.focus({ preventScroll: true });
                return;
            }
            if (!setPop.hidden) {
                closeSetPop();
                return;
            }
            if (reading) {
                closeReader();
                return;
            }
            requestClose();
            return;
        }
        if (event.key !== 'Tab') return;
        const list = focusables();
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        const active = doc.activeElement;
        if (event.shiftKey && (active === first || !root.contains(active))) {
            event.preventDefault();
            last.focus({ preventScroll: true });
        } else if (!event.shiftKey && (active === last || !root.contains(active))) {
            event.preventDefault();
            first.focus({ preventScroll: true });
        }
    }

    async function requestClose() {
        if (destroyed || closing || reading || sending) return;
        closing = true;
        exitBtn.disabled = true;
        root.classList.add('leaving');
        unmountBook();
        // 无论有没有借到册子都要通知宿页：宿页用它恢复暂停的主册更新
        if (typeof onClosed === 'function') {
            try {
                onClosed({ borrowed: borrowedAnything });
            } catch {
                /* 主册重装失败不应该卡住退出 */
            }
        }
        await sleep(200);
        destroy();
        if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        closing = true;
        sound.destroy();
        unmountBook();
        doc.removeEventListener('keydown', onKeyDown, true);
        win.clearTimeout(toastTimer);
        win.clearTimeout(confirmTimer);
        root.remove();
    }

    /* ── 事件 ───────────────────────────────────────────────────────────── */

    tabButtons.forEach((btn) => {
        btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    borrowBtn.addEventListener('click', () => startBorrow(linkInput.value));
    linkInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') startBorrow(linkInput.value);
    });

    openBookBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (mail.classList.contains('back')) openBook();
    });
    letter.addEventListener('click', () => {
        if (!mail.classList.contains('back') || busy || reading || !canOpenBook) return;
        openBook();
    });
    closeBtn.addEventListener('click', closeReader);

    setBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        setPop.hidden = !setPop.hidden;
        setBtn.setAttribute('aria-expanded', String(!setPop.hidden));
        if (!setPop.hidden) syncSettingsUI();
    });
    setPop.addEventListener('click', (event) => event.stopPropagation());
    root.addEventListener('click', (event) => {
        const target = event.target;
        if (!setPop.hidden && !setPop.contains(target) && !setBtn.contains(target)) closeSetPop();
        if (!codePop.hidden && !codePop.contains(target) && !friendBtn.contains(target)) closeCodePop();
    });

    setPop.querySelectorAll('[data-per]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const next = Number(btn.dataset.per) === 4 ? 4 : 1;
            if (next === view.perPage) return;
            view.perPage = next;
            syncSettingsUI();
            rebuildBook();
        });
    });

    yearToggle.addEventListener('click', () => {
        view.years = !view.years;
        syncSettingsUI();
        rebuildBook();
    });

    function friendCodeValue() {
        const code = String(albumData?.owner?.friendCode ?? '').trim();
        return /^\d{1,10}$/.test(code) ? code : '';
    }

    let codeSeq = 0;

    async function copyFriendCode() {
        const seq = ++codeSeq;
        const ok = await copyText(doc, codeValue.value);
        if (seq !== codeSeq) return ok;
        codeHint.textContent = ok
            ? '已复制，打开 Steam 添加好友即可粘贴。'
            : '浏览器不允许自动复制，请点一下方框全选后按 Ctrl+C。';
        return ok;
    }

    friendBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!codePop.hidden) {
            closeCodePop();
            return;
        }
        const code = friendCodeValue();
        if (!code) return;
        closeSetPop();
        codeValue.value = code;
        codeHint.textContent = '正在复制…';
        codePop.hidden = false;
        friendBtn.setAttribute('aria-expanded', 'true');
        await copyFriendCode();
        if (codePop.hidden) return;
        codeValue.focus({ preventScroll: true });
        codeValue.select?.();
    });

    codeCopy.addEventListener('click', async (event) => {
        event.stopPropagation();
        await copyFriendCode();
        if (codePop.hidden) return;
        codeValue.focus({ preventScroll: true });
        codeValue.select?.();
    });
    codePop.addEventListener('click', (event) => event.stopPropagation());

    function selectNodeText(node) {
        try {
            const range = doc.createRange();
            range.selectNodeContents(node);
            const selection = win.getSelection?.();
            selection?.removeAllRanges();
            selection?.addRange(range);
        } catch {
            /* 选区失败时至少把焦点给到借阅码 */
        }
    }

    copyBtn.addEventListener('click', async () => {
        if (!resultCode) return;
        const ok = await copyText(doc, resultCode);
        toast(ok ? '已复制借阅码，发给朋友吧' : '复制失败，请手动选中借阅码', ok ? 2400 : 3200);
        if (!ok) {
            codeOut.focus({ preventScroll: true });
            selectNodeText(codeOut);
        }
    });

    copyLinkBtn.addEventListener('click', async () => {
        if (!resultUrl) return;
        const ok = await copyText(doc, resultUrl);
        toast(ok ? '已复制短链接' : '复制失败，请稍后再试', ok ? 2400 : 3200);
    });

    syncBtn.addEventListener('click', syncLatest);
    renewBtn.addEventListener('click', () => armConfirm(renewBtn, '再点一次确认换新', renewLink));
    revokeBtn.addEventListener('click', () => armConfirm(revokeBtn, '再点一次确认收回', revokeLink));
    exitBtn.addEventListener('click', requestClose);

    doc.addEventListener('keydown', onKeyDown, true);

    /* ── 启动 ───────────────────────────────────────────────────────────── */

    requestAnimationFrame(() => {
        if (destroyed) return;
        const activeTab = root.querySelector('.rm-seg button.on');
        activeTab?.focus({ preventScroll: true });
    });
    sound.enter();
    prepareSend();

    return {
        destroy,
        close: requestClose,
        get open() {
            return !destroyed;
        },
    };
}
