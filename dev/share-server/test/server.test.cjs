'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createService } = require('../server.js');

const FIXTURE = require('./fixtures/share-demo.json');
const QUIET = { log() {}, error() {} };
const clone = (value) => JSON.parse(JSON.stringify(value));

let tmp;
let service;
let base;
let token;
let editKey;
let code;
let sharedAt;

async function startService(dir, options = {}) {
    const svc = createService({
        dbPath: path.join(dir, 'albums.db'),
        logger: QUIET,
        ...options,
    });
    await new Promise((resolve) => svc.server.listen(0, '127.0.0.1', resolve));
    return { svc, url: `http://127.0.0.1:${svc.server.address().port}` };
}

async function request(url, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(url, {
        method,
        headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    return { response, status: response.status, json, text };
}

const api = (pathname, options) => request(base + pathname, options);
const auth = () => ({ Authorization: `Bearer ${editKey}` });

before(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ac-share-test-'));
    const started = await startService(tmp);
    service = started.svc;
    base = started.url;
});

after(async () => {
    if (service) await service.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('健康检查 /healthz', async () => {
    const { status, json } = await api('/healthz');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.service, 'ac-share');
    assert.equal(json.albums, 0);
});

test('创建相册：201、token/editKey/code 形状、sharedAt = updatedAt、revision = 1', async () => {
    const { status, json } = await api('/api/albums', { method: 'POST', body: FIXTURE });
    assert.equal(status, 201);
    assert.match(json.token, /^[A-Za-z0-9_-]{22}$/);
    assert.match(json.editKey, /^[A-Za-z0-9_-]{32}$/);
    assert.match(json.code, /^\d{9}$/);
    assert.equal(json.revision, 1);
    assert.equal(json.sharedAt, json.updatedAt);
    assert.equal(json.url, `https://kevin0036.github.io/?c=${json.code}`);
    token = json.token;
    editKey = json.editKey;
    code = json.code;
    sharedAt = json.sharedAt;
});

test('读取相册：完整文档、ETag、If-None-Match 304', async () => {
    const { response, status, json, text } = await api(`/api/albums/${token}`);
    assert.equal(status, 200);
    assert.equal(response.headers.get('etag'), '"1"');
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.kind, 'achievement-album');
    assert.equal(json.sharedAt, sharedAt);
    assert.equal(json.updatedAt, sharedAt);
    assert.equal(json.revision, 1);
    assert.equal(json.owner.friendCode, '39734272');
    assert.equal(json.owner.steamid, undefined);
    assert.equal(json.cards.length, 3);
    assert.deepEqual(json.cards[0].cover, {
        front: { s: 1.12, x: -4.5, y: 0 },
        back: { mode: 'stretch' },
    });
    assert.equal('cover' in json.cards[1], false);
    assert.deepEqual(json.cards[1].art.capsule, []);
    assert.equal(json.years['2025'].badges[1].level, 'foil');
    assert.ok(!text.includes('7656119'), '响应里不应出现 SteamID64');

    const cached = await api(`/api/albums/${token}`, { headers: { 'If-None-Match': '"1"' } });
    assert.equal(cached.status, 304);
    assert.equal(cached.text, '');
    assert.equal(cached.response.headers.get('etag'), '"1"');
});

test('按短码读取：同一份文档、ETag 304、响应里没有 token', async () => {
    const { response, status, json, text } = await api(`/api/albums/by-code/${code}`);
    assert.equal(status, 200);
    assert.equal(response.headers.get('etag'), '"1"');
    assert.equal(json.kind, 'achievement-album');
    assert.equal(json.cards.length, 3);
    assert.ok(!text.includes(token), '按码读取不应泄露 token');

    const cached = await api(`/api/albums/by-code/${code}`, { headers: { 'If-None-Match': '"1"' } });
    assert.equal(cached.status, 304);
    assert.equal(cached.text, '');
    assert.equal(cached.response.headers.get('etag'), '"1"');
});

test('未知短码 / 格式错误都是 404，且短码不能修改或删除', async () => {
    const unknown = await api('/api/albums/by-code/000000001');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error, 'not_found');

    const malformed = await api('/api/albums/by-code/not-a-code');
    assert.equal(malformed.status, 404);

    const put = await api(`/api/albums/by-code/${code}`, {
        method: 'PUT',
        body: FIXTURE,
        headers: auth(),
    });
    assert.equal(put.status, 405);
});

test('编辑凭证：错误 403，正确更新后 revision +1、sharedAt 不变、短码不变', async () => {
    const denied = await api(`/api/albums/${token}`, {
        method: 'PUT',
        body: FIXTURE,
        headers: { Authorization: 'Bearer wrong-key-000000000000000000000000' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'forbidden');

    const changed = clone(FIXTURE);
    changed.cards[0].name = 'Stardew Valley 更新后';
    const updated = await api(`/api/albums/${token}`, { method: 'PUT', body: changed, headers: auth() });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.revision, 2);
    assert.equal(updated.json.sharedAt, sharedAt);
    assert.equal(updated.json.code, code);
    assert.equal(updated.json.url, `https://kevin0036.github.io/?c=${code}`);
    assert.ok(updated.json.updatedAt >= sharedAt);

    const read = await api(`/api/albums/${token}`);
    assert.equal(read.response.headers.get('etag'), '"2"');
    assert.equal(read.json.cards[0].name, 'Stardew Valley 更新后');
    assert.equal(read.json.revision, 2);
});

test('主人可用 editKey 取回短码，用于旧本地记录迁移', async () => {
    const denied = await api(`/api/albums/${token}/meta`);
    assert.equal(denied.status, 403);

    const meta = await api(`/api/albums/${token}/meta`, { headers: auth() });
    assert.equal(meta.status, 200);
    assert.equal(meta.json.code, code);
    assert.equal(meta.json.url, `https://kevin0036.github.io/?c=${code}`);
    assert.equal(meta.json.revision, 2);
    assert.equal(meta.json.token, undefined);
});

test('非法快照：400 + problems，且不改变已有版本', async () => {
    const missingKind = clone(FIXTURE);
    delete missingKind.kind;
    const bad = await api(`/api/albums/${token}`, { method: 'PUT', body: missingKind, headers: auth() });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_snapshot');
    assert.ok(bad.json.problems.some((line) => line.startsWith('kind:')));

    const read = await api(`/api/albums/${token}`);
    assert.equal(read.json.revision, 2);
});

test('身份字段：friendCode 允许，steamid / accountId 直接 400', async () => {
    const withSteamId = clone(FIXTURE);
    withSteamId.owner.steamid = '76561198000000000';
    const bad = await api('/api/albums', { method: 'POST', body: withSteamId });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.problems.some((line) => /steam_?id/i.test(line)));

    const withAccountId = clone(FIXTURE);
    withAccountId.cards[0].accountId = 123456;
    const bad2 = await api('/api/albums', { method: 'POST', body: withAccountId });
    assert.equal(bad2.status, 400);
    assert.ok(bad2.json.problems.some((line) => /account_?id/i.test(line)));
});

test('年份槽位：引用不存在的 appid 会清成空槽，空年份整项丢弃', async () => {
    const orphan = clone(FIXTURE);
    orphan.years['2025'].badges = [{ appid: 999, level: 5 }, null, null];
    orphan.years['2025'].banners = [999, null, null];
    const created = await api('/api/albums', { method: 'POST', body: orphan });
    assert.equal(created.status, 201);

    const read = await api(`/api/albums/${created.json.token}`);
    assert.deepEqual(read.json.years, {});
});

test('未知 token / 格式错误的 token 都是 404', async () => {
    const short = await api('/api/albums/short');
    assert.equal(short.status, 404);

    const unknown = await api('/api/albums/aaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error, 'not_found');
});

test('体积上限：超过 1 MB 的请求体返回 413', async () => {
    const padded = JSON.stringify({ ...FIXTURE, padding: 'x'.repeat(1100 * 1024) });
    const { status, json } = await api('/api/albums', { method: 'POST', body: padded });
    assert.equal(status, 413);
    assert.equal(json.error, 'payload_too_large');
});

test('CORS：白名单回显、预检 204、陌生 Origin 403', async () => {
    const preflight = await api('/api/albums', {
        method: 'OPTIONS',
        headers: {
            Origin: 'https://steamloopback.host',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
        },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.response.headers.get('access-control-allow-origin'), 'https://steamloopback.host');
    assert.match(preflight.response.headers.get('access-control-allow-methods'), /PUT/);
    assert.match(preflight.response.headers.get('access-control-allow-headers'), /Authorization/);

    const pages = await api('/api/ping', { headers: { Origin: 'https://kevin0036.github.io' } });
    assert.equal(pages.status, 200);
    assert.equal(pages.response.headers.get('access-control-allow-origin'), 'https://kevin0036.github.io');
    assert.match(pages.response.headers.get('access-control-expose-headers'), /ETag/);

    const evil = await api('/api/ping', { headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.error, 'origin_not_allowed');
});

test('创建限流：同一 IP 第二次创建返回 429', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-share-rate-'));
    const { svc, url } = await startService(dir, { limits: { create: 1 } });
    try {
        const first = await request(`${url}/api/albums`, { method: 'POST', body: FIXTURE });
        assert.equal(first.status, 201);
        const second = await request(`${url}/api/albums`, { method: 'POST', body: FIXTURE });
        assert.equal(second.status, 429);
        assert.equal(second.json.error, 'rate_limited');
    } finally {
        await svc.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('短码查询限流：同一 IP 超过上限返回 429', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-share-code-rate-'));
    const { svc, url } = await startService(dir, { limits: { codeLookup: 2 } });
    try {
        const created = await request(`${url}/api/albums`, { method: 'POST', body: FIXTURE });
        const first = await request(`${url}/api/albums/by-code/${created.json.code}`);
        const second = await request(`${url}/api/albums/by-code/${created.json.code}`);
        const third = await request(`${url}/api/albums/by-code/${created.json.code}`);
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(third.status, 429);
        assert.equal(third.json.error, 'rate_limited');
    } finally {
        await svc.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('重启后数据仍在（SQLite 持久化）', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-share-persist-'));
    const first = await startService(dir);
    let created;
    try {
        created = await request(`${first.url}/api/albums`, { method: 'POST', body: FIXTURE });
        assert.equal(created.status, 201);
    } finally {
        await first.svc.close();
    }

    const second = await startService(dir);
    try {
        const read = await request(`${second.url}/api/albums/${created.json.token}`);
        assert.equal(read.status, 200);
        assert.equal(read.json.revision, 1);
        assert.equal(read.json.cards.length, 3);
    } finally {
        await second.svc.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('旧库迁移：启动时补 viewed_at 和 share_code，旧相册可按码读取', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-share-legacy-'));
    const dbPath = path.join(dir, 'albums.db');
    const doc = JSON.stringify({
        schemaVersion: 1,
        kind: 'achievement-album',
        sharedAt: 1,
        updatedAt: 1,
        revision: 1,
        owner: { name: '旧相册' },
        album: {},
        cards: [],
        years: {},
    });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
        CREATE TABLE albums (
            token_hash TEXT PRIMARY KEY,
            edit_hash  TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            revision   INTEGER NOT NULL,
            bytes      INTEGER NOT NULL,
            doc        TEXT NOT NULL
        )
    `);
    legacy
        .prepare('INSERT INTO albums (token_hash, edit_hash, created_at, updated_at, revision, bytes, doc) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('legacy-token-hash', 'legacy-edit-hash', 1, 1, 1, Buffer.byteLength(doc), doc);
    legacy.close();

    const { svc, url } = await startService(dir);
    try {
        const row = svc.db.prepare('SELECT share_code, viewed_at FROM albums').get();
        assert.match(row.share_code, /^\d{9}$/);
        assert.equal(row.viewed_at, 1);

        const read = await request(`${url}/api/albums/by-code/${row.share_code}`);
        assert.equal(read.status, 200);
        assert.equal(read.json.owner.name, '旧相册');
    } finally {
        await svc.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('全站日创建上限：达到上限后换 IP 也返回 429 daily_cap_reached', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-share-daily-'));
    const { svc, url } = await startService(dir, { limits: { create: 100, dailyCreate: 2 } });
    try {
        const first = await request(`${url}/api/albums`, { method: 'POST', body: FIXTURE });
        const second = await request(`${url}/api/albums`, { method: 'POST', body: FIXTURE });
        const third = await request(`${url}/api/albums`, {
            method: 'POST',
            body: FIXTURE,
            headers: { 'X-Forwarded-For': '203.0.113.9' },
        });
        assert.equal(first.status, 201);
        assert.equal(second.status, 201);
        assert.equal(third.status, 429);
        assert.equal(third.json.error, 'daily_cap_reached');
    } finally {
        await svc.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('浏览时间：GET 记录 viewed_at，180 天未访问的册子可按 SQL 清理', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-share-viewed-'));
    const { svc, url } = await startService(dir);
    try {
        const created = await request(`${url}/api/albums`, { method: 'POST', body: FIXTURE });
        const token = created.json.token;
        const before = svc.db.prepare('SELECT viewed_at FROM albums').get();
        assert.equal(before.viewed_at, null);

        const read = await request(`${url}/api/albums/${token}`);
        assert.equal(read.status, 200);
        const afterRead = svc.db.prepare('SELECT viewed_at FROM albums').get();
        assert.ok(afterRead.viewed_at > 0);

        svc.db
            .prepare(
                "UPDATE albums SET created_at = CAST(strftime('%s','now','-200 day') AS INTEGER), updated_at = CAST(strftime('%s','now','-200 day') AS INTEGER), viewed_at = NULL",
            )
            .run();
        const cleanup = svc.db.prepare(
            "DELETE FROM albums WHERE MAX(COALESCE(viewed_at, 0), updated_at) < CAST(strftime('%s','now','-180 day') AS INTEGER)",
        );
        // 最近同步过、但从未被借阅的册子要保留
        svc.db.prepare("UPDATE albums SET updated_at = CAST(strftime('%s','now') AS INTEGER)").run();
        assert.equal(Number(cleanup.run().changes), 0);

        svc.db.prepare("UPDATE albums SET updated_at = CAST(strftime('%s','now','-200 day') AS INTEGER)").run();
        assert.equal(Number(cleanup.run().changes), 1);

        const gone = await request(`${url}/api/albums/${token}`);
        assert.equal(gone.status, 404);
    } finally {
        await svc.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('收回链接：错误凭证 403；正确删除 204 后 404', async () => {
    const denied = await api(`/api/albums/${token}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer wrong-key-000000000000000000000000' },
    });
    assert.equal(denied.status, 403);

    const removed = await api(`/api/albums/${token}`, { method: 'DELETE', headers: auth() });
    assert.equal(removed.status, 204);

    const gone = await api(`/api/albums/${token}`);
    assert.equal(gone.status, 404);
    assert.equal(gone.json.error, 'not_found');

    const codeGone = await api(`/api/albums/by-code/${code}`);
    assert.equal(codeGone.status, 404);
    assert.equal(codeGone.json.error, 'not_found');
});
