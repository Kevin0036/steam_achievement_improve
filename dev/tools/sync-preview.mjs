/**
 * Read the theme's own localStorage keys from a disposable copy of Steam's DB.
 * Steam's original DB is never opened by LevelDB or changed.
 * Usage: npm run preview:sync
 * Optional: node tools/sync-preview.mjs --cache-dir ".../Local Storage/leveldb"
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClassicLevel } from 'classic-level';
import { CACHE_VERSION } from '../../millennium/themes/AchievementCollection/src/js/ac/selectors.js';
import { decodeStorageString } from './preview-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--cache-dir')) {
    throw new Error('用法：node tools/sync-preview.mjs [--cache-dir <Steam localStorage leveldb 目录>]');
}
const source = args[1] ? path.resolve(args[1]) : path.join(process.env.LOCALAPPDATA, 'Steam', 'htmlcache', 'Default', 'Local Storage', 'leveldb');
const copy = mkdtempSync(path.join(tmpdir(), 'ac-preview-'));
let db;
const values = new Map();
try {
    cpSync(source, copy, { recursive: true, filter: file => !['LOCK', 'LOG', 'LOG.old'].includes(path.basename(file)) });
    db = new ClassicLevel(copy, { keyEncoding: 'buffer', valueEncoding: 'buffer', createIfMissing: false });
    await db.open();
    const wanted = `ac:v${CACHE_VERSION}:state`;
    for await (const [key, value] of db.iterator()) {
        const encodedKey = key.toString('latin1');
        if (encodedKey !== `_https://steamloopback.host\0\x01${wanted}` &&
            encodedKey !== `_http://steamloopback.host\0\x01${wanted}`) continue;
        values.set(wanted, decodeStorageString(value));
    }
} finally {
    if (db) await db.close();
    // Only remove the uniquely named disposable copy created above.
    if (path.dirname(copy) === path.resolve(tmpdir()) && path.basename(copy).startsWith('ac-preview-')) {
        rmSync(copy, { recursive: true, force: true });
    }
}

// Use the production reader, including its cache and rarity version invalidation.
// Its probe/removal writes affect this in-memory Map only.
globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
};
const { readState } = await import('../../millennium/themes/AchievementCollection/src/js/ac/cache.js');
const state = readState();
if (!state?.cards.length) throw new Error('未找到当前主题的卡片缓存，请先在 Steam 中打开成就卡包');

// Validate against progress before replacing the last good snapshot/fixtures.
const { generateFixtures } = await import('./make-preview-fixtures.mjs');
const snapshot = { formatVersion: 1, source: 'steam-client-theme-cache', savedAt: state.savedAt, cards: state.cards };
const generated = generateFixtures(snapshot);
writeFileSync(path.join(root, 'preview', 'client-snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');
generated.write();
console.log(`已同步客户端快照（${new Date(state.savedAt).toLocaleString('zh-CN')}）`);
if (state.stale) console.log('提示：客户端快照超过 24 小时；本次保留其真实数据，未联网猜测更新。');
