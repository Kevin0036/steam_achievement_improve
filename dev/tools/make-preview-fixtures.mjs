/** Generate preview data from the final client snapshot, never from legacy rates. */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildPreviewCards } from './preview-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEAM = path.resolve(HERE, '..', '..');
const PREVIEW = path.resolve(HERE, '..', 'preview');
const STEAMID64_BASE = 76561197960265728n;

function parseVdf(text) {
    const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}]/g) ?? [];
    let i = 0;
    const unquote = t => t.slice(1, -1).replace(/\\(.)/g, '$1');
    const readObject = () => {
        const obj = {};
        while (i < tokens.length) {
            const t = tokens[i++];
            if (t === '}') return obj;
            const key = unquote(t);
            const next = tokens[i++];
            obj[key] = next === '{' ? readObject() : unquote(next);
        }
        return obj;
    };
    return readObject();
}

const lowerKeys = obj => Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

function loginUsers(steamRoot) {
    const file = path.join(steamRoot, 'config', 'loginusers.vdf');
    return existsSync(file) ? lowerKeys(parseVdf(readFileSync(file, 'utf8'))).users ?? {} : {};
}

/** Match the whole completed library rather than taking the first userdata folder. */
export function loadMatchingProgress(snapshot, steamRoot = STEAM) {
    const users = loginUsers(steamRoot);
    const matches = [];
    const errors = [];
    for (const dir of readdirSync(path.join(steamRoot, 'userdata'), { withFileTypes: true })) {
        if (!dir.isDirectory() || !/^\d+$/.test(dir.name) || dir.name === '0') continue;
        const file = path.join(steamRoot, 'userdata', dir.name, 'config', 'librarycache', 'achievement_progress.json');
        if (!existsSync(file)) continue;
        try {
            const progress = JSON.parse(readFileSync(file, 'utf8')).mapCache;
            const cards = buildPreviewCards(snapshot.cards, progress);
            if (cards.length !== snapshot.cards.length) throw new Error('全成就游戏集合已变化');
            const steamId = (STEAMID64_BASE + BigInt(dir.name)).toString();
            matches.push({ accountId: dir.name, steamId, progress, cards, user: lowerKeys(users[steamId]) });
        } catch (error) {
            errors.push(`${dir.name}: ${error.message}`);
        }
    }
    const recent = matches.filter(match => match.user.mostrecent === '1');
    if (recent.length === 1) return recent[0];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error('多个账户的全成就集合相同，无法确定当前账户，请检查 loginusers.vdf 的 MostRecent');
    throw new Error(`没有账户的成就进度与客户端快照完整匹配，请在 Steam 中打开卡包并等待加载后重新同步。\n${errors.join('\n')}`);
}

export function generateFixtures(snapshot) {
    if (snapshot?.formatVersion !== 1 || snapshot.source !== 'steam-client-theme-cache' ||
        !Number.isFinite(snapshot.savedAt) || !Array.isArray(snapshot.cards) || snapshot.cards.length === 0) {
        throw new Error('无效或空的客户端快照，请运行 npm run preview:sync');
    }
    // Complete validation before any writes, preserving the last good preview on failure.
    const { cards, steamId, user } = loadMatchingProgress(snapshot);
    const avatarFile = path.join(STEAM, 'config', 'avatarcache', `${steamId}.png`);
    const owner = { persona: user.personaname ?? null, avatar: existsSync(avatarFile) ? './assets/avatar.png' : null };
    const meta = {
        source: snapshot.source,
        clientSavedAt: snapshot.savedAt,
        cardCount: cards.length,
        achievements: cards.reduce((sum, c) => sum + c.total, 0),
        rare: cards.reduce((sum, c) => sum + (c.rare ?? 0), 0),
        common: cards.reduce((sum, c) => sum + (c.common ?? 0), 0),
        unrated: cards.reduce((sum, c) => sum + (c.unrated ?? 0), 0),
        datedCards: cards.filter(c => c.completedAt != null).length,
    };
    const body = '// Generated from the final Steam theme cache. Run npm run preview:sync to update.\n' +
        `export const OWNER = ${JSON.stringify(owner)};\n` +
        `export const META = ${JSON.stringify(meta, null, 2)};\n` +
        `export const CARDS = ${JSON.stringify(cards, null, 2)};\n`;
    return {
        cards, meta,
        write() {
            mkdirSync(PREVIEW, { recursive: true });
            if (owner.avatar) {
                mkdirSync(path.join(PREVIEW, 'assets'), { recursive: true });
                copyFileSync(avatarFile, path.join(PREVIEW, 'assets', 'avatar.png'));
            }
            writeFileSync(path.join(PREVIEW, 'fixtures.js'), body, 'utf8');
            console.log(`预览已生成：${meta.cardCount} 张卡，${meta.achievements} 项成就，金 ${meta.rare} / 银 ${meta.common} / 未统计 ${meta.unrated}，${meta.datedCards} 款有完成日期`);
        },
    };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const file = path.join(PREVIEW, 'client-snapshot.json');
    if (!existsSync(file)) throw new Error('尚无客户端快照，请先运行 npm run preview:sync');
    generateFixtures(JSON.parse(readFileSync(file, 'utf8'))).write();
}
