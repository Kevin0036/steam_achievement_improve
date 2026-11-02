/**
 * 只读解析 appcache/appinfo.vdf（v29，带字符串表），取出指定 appid 的游戏名。
 *
 * 仅供生成预览数据使用：正式主题在客户端里直接读 appStore 的 display_name，
 * 不碰这个文件。
 *
 * v29 布局：
 *   u32 magic(0x07564429) · u32 universe · i64 字符串表偏移
 *   每个 app：u32 appid(0 结束) · u32 size · u32 state · u32 updated · u64 token
 *             · 20B sha1 · u32 change · 20B binary sha1 · 二进制 KV
 *   二进制 KV：u8 类型（0 子节 / 1 字符串 / 2 int32 / 7 uint64 / 8 结束）
 *             · i32 键名（字符串表下标）· 值
 */
import { readFileSync } from 'node:fs';

export function readAppNames(file, wanted) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x07564429) throw new Error('不是 v29 的 appinfo.vdf');

  const tableOffset = Number(buf.readBigInt64LE(8));
  const strings = [];
  {
    let p = tableOffset;
    const count = buf.readUInt32LE(p);
    p += 4;
    for (let i = 0; i < count; i += 1) {
      const end = buf.indexOf(0, p);
      strings.push(buf.toString('utf8', p, end));
      p = end + 1;
    }
  }

  const cstr = (p) => {
    const end = buf.indexOf(0, p);
    return [buf.toString('utf8', p, end), end + 1];
  };

  /** 读一个 KV 子节，返回 [对象, 结束位置] */
  const readSection = (p) => {
    const out = {};
    for (;;) {
      const type = buf[p];
      p += 1;
      if (type === 8) return [out, p];
      const key = strings[buf.readInt32LE(p)];
      p += 4;
      if (type === 0) {
        const [child, next] = readSection(p);
        out[key] = child;
        p = next;
      } else if (type === 1) {
        const [value, next] = cstr(p);
        out[key] = value;
        p = next;
      } else if (type === 2 || type === 3 || type === 4 || type === 6) {
        out[key] = buf.readInt32LE(p);
        p += 4;
      } else if (type === 7 || type === 10) {
        out[key] = buf.readBigUInt64LE(p).toString();
        p += 8;
      } else {
        throw new Error(`未知 KV 类型 ${type} @${p}`);
      }
    }
  };

  const result = new Map();
  let p = 16;
  while (p < tableOffset) {
    const appid = buf.readUInt32LE(p);
    if (appid === 0) break;
    const size = buf.readUInt32LE(p + 4);
    const next = p + 8 + size;
    if (wanted.has(appid)) {
      const kvStart = p + 8 + 4 + 4 + 8 + 20 + 4 + 20;
      try {
        const [root] = readSection(kvStart);
        const common = root.appinfo?.common ?? {};
        result.set(appid, {
          name: common.name ?? null,
          schinese: common.name_localized?.schinese ?? null,
        });
      } catch {
        // 单条坏数据不影响其它条目
      }
    }
    p = next;
  }
  return result;
}
