'use strict';

/**
 * 成就收藏册 · 分享 API
 *
 * 只做五件事：保存快照、按短码 / token 读取、用 editKey 更新 / 删除、健康检查。
 * 借阅室页面由 GitHub Pages 托管，这里不渲染任何 HTML。
 *
 * 端点与安全规则见 achievement_improve/docs/分享收藏册-MVP-TODO.md §4。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { MAX_DOC_BYTES, validateSnapshot } = require('./snapshot.js');

const VERSION = '1.1.0';
const BODY_LIMIT = 1024 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CODE_PATTERN = /^\d{6,15}$/;
const DEFAULT_VIEWER_BASE = 'https://kevin0036.github.io/';

function codeDigitsFromEnv() {
    const value = Number.parseInt(process.env.AC_CODE_DIGITS ?? '', 10);
    return Number.isInteger(value) && value >= 6 && value <= 12 ? value : 9;
}

const ALLOWED_ORIGINS = new Set([
    'https://steamloopback.host',
    'http://steamloopback.host',
    'https://kevin0036.github.io',
]);
// 仅本地联调：比如 AC_EXTRA_ORIGINS=http://127.0.0.1:4173；生产不设置
for (const origin of String(process.env.AC_EXTRA_ORIGINS ?? '').split(',')) {
    const value = origin.trim();
    if (value) ALLOWED_ORIGINS.add(value);
}
const ALLOWED_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization';

function hash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(bytes) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function randomShareCode(digits) {
    const min = 10 ** (digits - 1);
    const max = 10 ** digits;
    return String(crypto.randomInt(min, max));
}

function safeEqualHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function corsHeaders(origin) {
    const headers = {
        Vary: 'Origin',
        'Access-Control-Allow-Methods': ALLOWED_METHODS,
        'Access-Control-Allow-Headers': ALLOWED_HEADERS,
        'Access-Control-Expose-Headers': 'ETag',
        'Access-Control-Max-Age': '600',
    };
    if (origin && ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
    return headers;
}

function sendJson(res, status, body, origin, extra = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex',
        ...corsHeaders(origin),
        ...extra,
    });
    res.end(payload);
}

function sendEmpty(res, status, origin, extra = {}) {
    res.writeHead(status, {
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        ...corsHeaders(origin),
        ...extra,
    });
    res.end();
}

function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress ?? '';
}

function bearer(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return match ? match[1] : null;
}

function readJsonBody(req, limit) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let tooLarge = false;
        let chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                tooLarge = true;
                chunks = [];
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (tooLarge) {
                reject(Object.assign(new Error('payload_too_large'), { status: 413 }));
                return;
            }
            if (size === 0) {
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(Object.assign(new Error('bad_json'), { status: 400 }));
            }
        });
        req.on('error', reject);
    });
}

function createRateLimiter(limit, windowMs = 60 * 60 * 1000) {
    if (!Number.isFinite(limit) || limit <= 0) return () => true;
    const buckets = new Map();
    let lastSweep = Date.now();
    return (key) => {
        const now = Date.now();
        if (now - lastSweep > windowMs) {
            for (const [bucketKey, bucket] of buckets) {
                if (bucket.resetAt <= now) buckets.delete(bucketKey);
            }
            lastSweep = now;
        }
        let bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }
        bucket.count += 1;
        return bucket.count <= limit;
    };
}

function withServerFields(doc, sharedAt, updatedAt, revision) {
    return {
        schemaVersion: doc.schemaVersion,
        kind: doc.kind,
        sharedAt,
        updatedAt,
        revision,
        owner: doc.owner,
        album: doc.album,
        cards: doc.cards,
        years: doc.years,
    };
}

function defaultDbPath() {
    const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
    return path.join(dir, 'albums.db');
}

function codeViewerUrl(viewerBase, code) {
    const base = viewerBase.endsWith('/') ? viewerBase : `${viewerBase}/`;
    return `${base}?c=${encodeURIComponent(code)}`;
}

/**
 * @param {object} [options]
 * @param {string} [options.dbPath]
 * @param {string} [options.viewerBase]
 * @param {number} [options.bodyLimit]
 * @param {number} [options.codeDigits]
 * @param {{create?:number, update?:number, codeLookup?:number}} [options.limits]
 * @param {Console} [options.logger]
 * @param {() => number} [options.now]
 */
function createService({
    dbPath = defaultDbPath(),
    viewerBase = process.env.SHARE_VIEWER_BASE || DEFAULT_VIEWER_BASE,
    bodyLimit = BODY_LIMIT,
    codeDigits = codeDigitsFromEnv(),
    limits = {},
    logger = console,
    now = () => Math.floor(Date.now() / 1000),
} = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    if (!Number.isInteger(codeDigits) || codeDigits < 6 || codeDigits > 12) codeDigits = 9;
    db.exec(`
        CREATE TABLE IF NOT EXISTS albums (
            token_hash TEXT PRIMARY KEY,
            edit_hash  TEXT NOT NULL,
            share_code TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            viewed_at  INTEGER,
            revision   INTEGER NOT NULL,
            bytes      INTEGER NOT NULL,
            doc        TEXT NOT NULL
        )
    `);
    const columns = db.prepare('PRAGMA table_info(albums)').all();
    if (!columns.some((column) => column.name === 'viewed_at')) {
        db.exec('ALTER TABLE albums ADD COLUMN viewed_at INTEGER');
        db.exec('UPDATE albums SET viewed_at = updated_at WHERE viewed_at IS NULL');
    }
    if (!columns.some((column) => column.name === 'share_code')) {
        db.exec('ALTER TABLE albums ADD COLUMN share_code TEXT');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS albums_share_code ON albums(share_code)');

    const insertAlbum = db.prepare(
        'INSERT INTO albums (token_hash, edit_hash, share_code, created_at, updated_at, viewed_at, revision, bytes, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const selectAlbum = db.prepare(
        'SELECT token_hash, edit_hash, share_code, created_at, updated_at, viewed_at, revision, bytes, doc FROM albums WHERE token_hash = ?',
    );
    const selectByCode = db.prepare(
        'SELECT token_hash, created_at, updated_at, viewed_at, revision, bytes, doc FROM albums WHERE share_code = ?',
    );
    const updateAlbumStmt = db.prepare(
        'UPDATE albums SET edit_hash = ?, updated_at = ?, revision = ?, bytes = ?, doc = ? WHERE token_hash = ?',
    );
    const deleteAlbumStmt = db.prepare('DELETE FROM albums WHERE token_hash = ?');
    const markViewedStmt = db.prepare('UPDATE albums SET viewed_at = ? WHERE token_hash = ?');
    const assignCodeStmt = db.prepare('UPDATE albums SET share_code = ? WHERE token_hash = ?');
    const codeExists = db.prepare('SELECT 1 AS ok FROM albums WHERE share_code = ?');
    const countAlbums = db.prepare('SELECT COUNT(*) AS count FROM albums');
    const countCreatedSince = db.prepare('SELECT COUNT(*) AS count FROM albums WHERE created_at >= ?');
    const pingDb = db.prepare('SELECT 1 AS ok');

    function allocateCode() {
        for (let attempt = 0; attempt < 32; attempt += 1) {
            const code = randomShareCode(codeDigits);
            if (!codeExists.get(code)) return code;
        }
        throw new Error('code_generation_failed');
    }

    // 旧相册在启动时补一个短码；唯一索引会兜住并发/异常情况
    for (const row of db.prepare('SELECT token_hash FROM albums WHERE share_code IS NULL').all()) {
        assignCodeStmt.run(allocateCode(), row.token_hash);
    }

    const limitCreate = createRateLimiter(limits.create ?? 10);
    const limitUpdate = createRateLimiter(limits.update ?? 60);
    // 短码查询是公开入口，必须限流；数字位数固定时空间有限
    const envCodeLookup = Number.parseInt(process.env.AC_CODE_LOOKUP_LIMIT ?? '', 10);
    const limitCodeLookup = createRateLimiter(
        limits.codeLookup ?? (Number.isFinite(envCodeLookup) ? envCodeLookup : 120),
    );
    // 全站日创建上限：按 UTC 零点重置，防止换 IP 绕过单机限流；AC_DAILY_CREATE_LIMIT=0 关闭
    const envDaily = Number.parseInt(process.env.AC_DAILY_CREATE_LIMIT ?? '', 10);
    const dailyCreate = limits.dailyCreate ?? (Number.isFinite(envDaily) ? envDaily : 200);
    const dayStartOf = (seconds) => Math.floor(seconds / 86400) * 86400;

    const server = http.createServer(async (req, res) => {
        const started = Date.now();
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
        const ip = clientIp(req);
        let route = 'unknown';
        let tokenLabel = '';

        const tokenPath = (() => {
            try {
                return new URL(req.url ?? '/', 'http://localhost').pathname;
            } catch {
                return '';
            }
        })();

        res.on('finish', () => {
            const ms = Date.now() - started;
            logger.log(
                `${new Date().toISOString()} ${ip} ${route} ${res.statusCode} ${ms}ms` +
                    `${origin ? ` origin=${origin}` : ''}${tokenLabel ? ` ${tokenLabel}` : ''}`,
            );
        });

        const respondJson = (status, body, extra) => sendJson(res, status, body, origin, extra);
        const respondEmpty = (status, extra) => sendEmpty(res, status, origin, extra);
        const rejectUnauthorized = () => {
            req.resume();
            respondJson(403, { ok: false, error: 'forbidden' });
        };
        const sendAlbumDoc = (req, res, row) => {
            // 每本册子每天最多写一次浏览时间，供「180 天未访问」清理使用
            if (!row.viewed_at || now() - row.viewed_at >= 86400) {
                try {
                    markViewedStmt.run(now(), row.token_hash);
                } catch {
                    // 记录浏览时间失败不影响正常读取
                }
            }
            const etag = `"${row.revision}"`;
            const ifNoneMatch = String(req.headers['if-none-match'] ?? '');
            if (ifNoneMatch === etag || ifNoneMatch === `W/${etag}`) {
                respondEmpty(304, { ETag: etag, 'Cache-Control': 'no-cache' });
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(row.doc),
                'Cache-Control': 'no-cache',
                ETag: etag,
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
                'X-Robots-Tag': 'noindex',
                ...corsHeaders(origin),
            });
            res.end(row.doc);
        };

        try {
            if (origin && !ALLOWED_ORIGINS.has(origin)) {
                req.resume();
                respondJson(403, { ok: false, error: 'origin_not_allowed' });
                return;
            }

            if (req.method === 'OPTIONS') {
                route = 'OPTIONS';
                respondEmpty(204);
                return;
            }

            if (req.method === 'GET' && tokenPath === '/healthz') {
                route = 'GET /healthz';
                pingDb.get();
                const { count } = countAlbums.get();
                respondJson(200, { ok: true, service: 'ac-share', version: VERSION, albums: Number(count) });
                return;
            }

            if (tokenPath === '/api/ping' && (req.method === 'GET' || req.method === 'POST')) {
                route = `${req.method} /api/ping`;
                if (req.method === 'POST') req.resume();
                respondJson(200, { ok: true, service: 'ac-share', version: VERSION, method: req.method, time: now() });
                return;
            }

            if (req.method === 'POST' && tokenPath === '/api/albums') {
                route = 'POST /api/albums';
                if (!limitCreate(ip)) {
                    req.resume();
                    respondJson(429, { ok: false, error: 'rate_limited' });
                    return;
                }
                if (dailyCreate > 0 && Number(countCreatedSince.get(dayStartOf(now())).count) >= dailyCreate) {
                    req.resume();
                    respondJson(429, { ok: false, error: 'daily_cap_reached' });
                    return;
                }

                let body;
                try {
                    body = await readJsonBody(req, bodyLimit);
                } catch (err) {
                    respondJson(err.status ?? 400, { ok: false, error: err.message });
                    return;
                }

                const result = validateSnapshot(body);
                if (!result.ok) {
                    respondJson(400, { ok: false, error: 'invalid_snapshot', problems: result.problems });
                    return;
                }

                const token = randomToken(16);
                const editKey = randomToken(24);
                const code = allocateCode();
                tokenLabel = `token=${token.slice(0, 6)}#${hash(token).slice(0, 8)}`;
                const sharedAt = now();
                const revision = 1;
                const stored = JSON.stringify(withServerFields(result.doc, sharedAt, sharedAt, revision));
                if (Buffer.byteLength(stored) > MAX_DOC_BYTES) {
                    respondJson(413, { ok: false, error: 'document_too_large' });
                    return;
                }

                insertAlbum.run(
                    hash(token),
                    hash(editKey),
                    code,
                    sharedAt,
                    sharedAt,
                    null,
                    revision,
                    Buffer.byteLength(stored),
                    stored,
                );
                respondJson(201, {
                    ok: true,
                    token,
                    editKey,
                    code,
                    url: codeViewerUrl(viewerBase, code),
                    sharedAt,
                    updatedAt: sharedAt,
                    revision,
                });
                return;
            }

            const codeMatch = /^\/api\/albums\/by-code\/(\d{6,15})$/.exec(tokenPath);
            if (codeMatch) {
                const code = codeMatch[1];
                route = `${req.method} /api/albums/by-code/:code`;
                tokenLabel = `code=***${code.slice(-3)}#${hash(code).slice(0, 8)}`;
                if (req.method !== 'GET') {
                    req.resume();
                    respondJson(405, { ok: false, error: 'method_not_allowed' });
                    return;
                }
                if (!CODE_PATTERN.test(code)) {
                    respondJson(404, { ok: false, error: 'not_found' });
                    return;
                }
                if (!limitCodeLookup(ip)) {
                    req.resume();
                    respondJson(429, { ok: false, error: 'rate_limited' });
                    return;
                }
                const row = selectByCode.get(code);
                if (!row) {
                    req.resume();
                    respondJson(404, { ok: false, error: 'not_found' });
                    return;
                }
                sendAlbumDoc(req, res, row);
                return;
            }

            const metaMatch = /^\/api\/albums\/([A-Za-z0-9_-]{22})\/meta$/.exec(tokenPath);
            if (metaMatch) {
                const token = metaMatch[1];
                route = `${req.method} /api/albums/:token/meta`;
                tokenLabel = `token=${token.slice(0, 6)}#${hash(token).slice(0, 8)}`;
                if (req.method !== 'GET') {
                    req.resume();
                    respondJson(405, { ok: false, error: 'method_not_allowed' });
                    return;
                }
                const row = selectAlbum.get(hash(token));
                if (!row) {
                    req.resume();
                    respondJson(404, { ok: false, error: 'not_found' });
                    return;
                }
                if (!safeEqualHex(hash(bearer(req) ?? ''), row.edit_hash)) {
                    rejectUnauthorized();
                    return;
                }
                let code = row.share_code;
                if (!code) {
                    code = allocateCode();
                    assignCodeStmt.run(code, row.token_hash);
                }
                respondJson(200, {
                    ok: true,
                    code,
                    url: codeViewerUrl(viewerBase, code),
                    sharedAt: row.created_at,
                    updatedAt: row.updated_at,
                    revision: row.revision,
                });
                return;
            }

            const albumMatch = /^\/api\/albums\/([A-Za-z0-9_-]{22})$/.exec(tokenPath);
            if (albumMatch) {
                const token = albumMatch[1];
                if (!TOKEN_PATTERN.test(token)) {
                    respondJson(404, { ok: false, error: 'not_found' });
                    return;
                }
                const tokenHash = hash(token);
                tokenLabel = `token=${token.slice(0, 6)}#${tokenHash.slice(0, 8)}`;
                route = `${req.method} /api/albums/:token`;
                const row = selectAlbum.get(tokenHash);

                if (!row) {
                    req.resume();
                    respondJson(404, { ok: false, error: 'not_found' });
                    return;
                }

                const editKey = bearer(req);
                if (req.method === 'GET') {
                    sendAlbumDoc(req, res, row);
                    return;
                }

                if (!safeEqualHex(hash(editKey ?? ''), row.edit_hash)) {
                    rejectUnauthorized();
                    return;
                }

                if (req.method === 'PUT') {
                    if (!limitUpdate(ip)) {
                        req.resume();
                        respondJson(429, { ok: false, error: 'rate_limited' });
                        return;
                    }

                    let body;
                    try {
                        body = await readJsonBody(req, bodyLimit);
                    } catch (err) {
                        respondJson(err.status ?? 400, { ok: false, error: err.message });
                        return;
                    }

                    const result = validateSnapshot(body);
                    if (!result.ok) {
                        respondJson(400, { ok: false, error: 'invalid_snapshot', problems: result.problems });
                        return;
                    }

                    const revision = row.revision + 1;
                    const updatedAt = now();
                    const stored = JSON.stringify(withServerFields(result.doc, row.created_at, updatedAt, revision));
                    if (Buffer.byteLength(stored) > MAX_DOC_BYTES) {
                        respondJson(413, { ok: false, error: 'document_too_large' });
                        return;
                    }

                    updateAlbumStmt.run(row.edit_hash, updatedAt, revision, Buffer.byteLength(stored), stored, tokenHash);
                    let code = row.share_code;
                    if (!code) {
                        code = allocateCode();
                        assignCodeStmt.run(code, tokenHash);
                    }
                    respondJson(200, {
                        ok: true,
                        code,
                        url: codeViewerUrl(viewerBase, code),
                        sharedAt: row.created_at,
                        updatedAt,
                        revision,
                    });
                    return;
                }

                if (req.method === 'DELETE') {
                    req.resume();
                    deleteAlbumStmt.run(tokenHash);
                    respondEmpty(204);
                    return;
                }

                respondJson(405, { ok: false, error: 'method_not_allowed' });
                return;
            }

            if (req.method === 'POST' || req.method === 'PUT') req.resume();
            respondJson(404, { ok: false, error: 'not_found' });
        } catch (err) {
            logger.error(`ac-share error: ${err?.stack ?? err}`);
            if (!res.headersSent) respondJson(500, { ok: false, error: 'internal_error' });
            else res.end();
        }
    });

    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.on('clientError', (err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });

    return {
        server,
        db,
        dbPath,
        close() {
            return new Promise((resolve) => {
                server.close(() => {
                    try {
                        db.close();
                    } catch {
                        // 已关闭
                    }
                    resolve();
                });
                server.closeIdleConnections?.();
            });
        },
    };
}

if (require.main === module) {
    const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
    const HOST = process.env.HOST ?? '127.0.0.1';
    const service = createService();
    service.server.listen(PORT, HOST, () => {
        console.log(`${new Date().toISOString()} ac-share v${VERSION} listening on http://${HOST}:${PORT} (db: ${service.dbPath})`);
    });

    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`${new Date().toISOString()} ${signal} received, shutting down`);
        service.close().then(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { createService, codeViewerUrl, VERSION };
