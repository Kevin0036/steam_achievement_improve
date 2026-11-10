/** Run the real Windows PowerShell 5.1 installer against disposable Steam roots.
 * No fixture executable or DLL is executed; Steam processes are never touched.
 * Run from any directory: node --test dev/tools/test-lazy-install.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('lazy installer checks the Steam executable before installing the x64 core', {
    skip: process.platform !== 'win32' ? 'requires Windows PowerShell 5.1' : false,
}, async (t) => {
    const systemRoot = process.env.SystemRoot;
    const nativeDir = existsSync(path.join(systemRoot, 'Sysnative')) ? 'Sysnative' : 'System32';
    const powershell = path.join(systemRoot, nativeDir, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const x86PowerShell = path.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    assert.ok(existsSync(x86PowerShell), 'requires 64-bit Windows with a real x86 executable');

    const scratch = path.join(REPO, 'dev', '.tmp');
    mkdirSync(scratch, { recursive: true });
    const temp = mkdtempSync(path.join(scratch, 'lazy-install-'));
    // This path is created by this test, below its own scratch directory.
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const packageDir = path.join(temp, 'package');
    mkdirSync(packageDir);
    const installer = path.join(packageDir, 'install.ps1');
    copyFileSync(path.join(REPO, 'packaging', 'lazy', 'install.ps1'), installer);
    const script = readFileSync(installer, 'utf8');
    const pluginVersion = script.match(/\$script:PluginVersion = '([^']+)'/)[1];
    const coreVersion = script.match(/\$script:MillenniumVersion = '([^']+)'/)[1];

    function put(relative, content) {
        const file = path.join(packageDir, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
    }
    put('plugin/AchievementCollection/plugin.json', JSON.stringify({ version: pluginVersion }));
    put('plugin/AchievementCollection/.millennium/Dist/index.js', '// fixture only');
    put('plugin/AchievementCollection/backend/main.lua', '-- fixture only');
    put('core/millennium/lib/millennium.dll', 'fixture core, never loaded');
    put('core/millennium/bin/millennium.luavm64.exe', 'fixture runtime, never executed');
    put('core/wsock32.dll', 'fixture x64 loader, never loaded');
    const archive = path.join(packageDir, `millennium-v${coreVersion}-windows-x86_64.zip`);
    const tar = spawnSync(path.join(systemRoot, nativeDir, 'tar.exe'), [
        '-a', '-c', '-f', archive, '-C', path.join(packageDir, 'core'), 'millennium', 'wsock32.dll',
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(tar.status, 0, tar.stderr);
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    put(`millennium-v${coreVersion}-windows-x86_64.sha256`, digest);

    function steamRoot(name, executable = powershell) {
        const root = path.join(temp, name);
        mkdirSync(root);
        copyFileSync(executable, path.join(root, 'steam.exe'));
        return root;
    }
    function run(root) {
        return spawnSync(powershell, [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-SteamPath', root,
            '-NoLaunch', '-InternalYes', '-InternalNoElevate', '-InternalSkipProcessStop',
        ], {
            encoding: 'utf8', windowsHide: true, timeout: 30000,
            // PowerShell 7's inherited module path may hide the Windows 5.1 cmdlets.
            env: { ...process.env, PSModulePath: path.join(systemRoot, nativeDir, 'WindowsPowerShell', 'v1.0', 'Modules') },
        });
    }
    function snapshot(root) {
        const files = {};
        for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
            const file = path.join(entry.parentPath, entry.name);
            files[path.relative(root, file)] = entry.isDirectory() ? 'directory'
                : createHash('sha256').update(readFileSync(file)).digest('hex');
        }
        return files;
    }
    async function rejectUnchanged(root, expectedMessage) {
        const before = snapshot(root);
        const mutations = [];
        const observer = watch(root, { recursive: true }, (event, name) => mutations.push(`${event}:${name}`));
        let result;
        try {
            result = run(root);
            // Let Windows deliver even transient changes such as the writable probe.
            await new Promise((resolve) => setTimeout(resolve, 50));
        } finally {
            observer.close();
        }
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stdout, expectedMessage);
        assert.deepEqual(snapshot(root), before, 'rejection must preserve the complete Steam root');
        assert.deepEqual(mutations, [], 'rejection must happen before any Steam-root write');
    }
    function changeHeader(root, change) {
        const file = path.join(root, 'steam.exe');
        const bytes = readFileSync(file);
        change(bytes);
        writeFileSync(file, bytes);
    }

    await t.test('accepts a real AMD64 executable and installs the core and plugin', () => {
        const root = steamRoot('amd64');
        const result = run(root);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(readFileSync(path.join(root, 'wsock32.dll'), 'utf8'), 'fixture x64 loader, never loaded');
        assert.ok(existsSync(path.join(root, 'millennium', 'plugins', 'AchievementCollection', 'plugin.json')));
        const manifest = JSON.parse(readFileSync(path.join(root, 'millennium', '.ac-installer', 'manifest.json'), 'utf8'));
        assert.equal(manifest.installedCore, true);
    });
    await t.test('rejects a real x86 executable on 64-bit Windows', () => {
        return rejectUnchanged(steamRoot('x86', x86PowerShell), /0x014C/);
    });
    await t.test('rejects an ARM64 executable', () => {
        const root = steamRoot('arm64');
        changeHeader(root, (bytes) => bytes.writeUInt16LE(0xaa64, bytes.readUInt32LE(0x3c) + 4));
        return rejectUnchanged(root, /0xAA64/);
    });
    await t.test('rejects truncated executable headers', () => {
        const root = steamRoot('truncated');
        writeFileSync(path.join(root, 'steam.exe'), 'MZ');
        return rejectUnchanged(root, /steam\.exe/);
    });
    await t.test('rejects a missing DOS signature', () => {
        const root = steamRoot('bad-dos');
        changeHeader(root, (bytes) => bytes.writeUInt16LE(0, 0));
        return rejectUnchanged(root, /steam\.exe/);
    });
    await t.test('rejects a missing PE signature', () => {
        const root = steamRoot('bad-pe');
        changeHeader(root, (bytes) => bytes.writeUInt32LE(0, bytes.readUInt32LE(0x3c)));
        return rejectUnchanged(root, /steam\.exe/);
    });
    await t.test('rejects an out-of-range PE header offset', () => {
        const root = steamRoot('bad-offset');
        changeHeader(root, (bytes) => bytes.writeUInt32LE(0x7fffffff, 0x3c));
        return rejectUnchanged(root, /steam\.exe/);
    });
    await t.test('preserves an existing third-party wsock32.dll', () => {
        const root = steamRoot('third-party');
        writeFileSync(path.join(root, 'wsock32.dll'), 'another mod');
        return rejectUnchanged(root, /wsock32\.dll/);
    });
    await t.test('keeps plugin-only updates without replacing an existing core', () => {
        const root = steamRoot('existing-core', x86PowerShell);
        const core = path.join(root, 'millennium', 'lib', 'millennium.dll');
        mkdirSync(path.dirname(core), { recursive: true });
        writeFileSync(core, 'existing core');
        writeFileSync(path.join(root, 'wsock32.dll'), 'existing loader');
        const result = run(root);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(readFileSync(core, 'utf8'), 'existing core');
        assert.equal(readFileSync(path.join(root, 'wsock32.dll'), 'utf8'), 'existing loader');
        assert.ok(existsSync(path.join(root, 'millennium', 'plugins', 'AchievementCollection', 'plugin.json')));
        const manifest = JSON.parse(readFileSync(path.join(root, 'millennium', '.ac-installer', 'manifest.json'), 'utf8'));
        assert.equal(manifest.installedCore, false);
    });
});
