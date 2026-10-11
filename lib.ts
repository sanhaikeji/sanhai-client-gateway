/**
 * 通用工具：时间、令牌、以及一个小巧的限流器。
 *
 * 这些看起来琐碎，但签到这类功能**全靠日期算对**，所以时间处理单独拎出来、并且
 * 固定时区（不跟着服务器的 TZ 走）—— 服务器在 UTC、学生在东八区，用本地时间算
 * 「今天」会差出一整天，签到的连续天数就全乱了。
 */
import { randomBytes, createHash, timingSafeEqual } from 'crypto';

/** 签到/每日类功能一律按这个时区算「一天」。 */
export const TZ = 'Asia/Shanghai';

/**
 * 把一个时刻格式化成 `YYYY-MM-DD`（按 {@link TZ}）。
 * 用 `en-CA` 这个 locale 是因为它恰好输出 `2026-10-11` 这种形式，省掉手工拼装。
 */
export function dateKey(d: Date = new Date(), offsetDays = 0): string {
    const t = new Date(d.getTime() + offsetDays * 86400_000);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(t);
}

/** 今天（按 {@link TZ}）。 */
export const today = () => dateKey();
/** 昨天（按 {@link TZ}）。 */
export const yesterday = () => dateKey(new Date(), -1);

/**
 * 给定某一天（`YYYY-MM-DD`），返回它的前一天。
 *
 * <para>签到算连续天数必须用它、**不能用 `yesterday()`** —— 后者跟着真实时钟走，
 * 一旦要处理「不是今天」的日子（补签、测试、或者服务器时钟和请求日期不一致），
 * 连续判断就会错。取 12:00 是为了避开时区边界。</para>
 */
export function prevDay(d: string): string {
    return dateKey(new Date(`${d}T12:00:00+08:00`), -1);
}

/** 生成一个随机令牌（给客户端用的那种，字符串形态）。 */
export const newToken = () => randomBytes(32).toString('base64url');

/** 令牌落库只存哈希 —— 数据库被看到也不等于令牌泄露。 */
export const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** 恒定时间比较，避免时序侧信道（主要给配对码用）。 */
export function safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

/** 生成 6 位数字配对码。 */
export function newPairCode(): string {
    // 不用 Math.random —— 那个可预测。这里取随机字节再取模。
    const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
    return String(n).padStart(6, '0');
}

/**
 * 极简内存限流器（按 key 计数，滑动窗口）。
 *
 * 只为挡住「疯狂重放」这种低级刷法 —— 它**不是**安全边界（进程重启就清零、
 * 多实例不共享）。真正的防刷在数据层：签到是幂等的（一天一条），所以哪怕限流
 * 被绕过也只会得到「今天已经签过了」。
 */
const hits = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
        hits.set(key, arr);
        return false;
    }
    arr.push(now);
    hits.set(key, arr);
    return true;
}

/** 大对象瘦身：把记录里的代码截断，避免客户端一次拉回几 MB。 */
export function clip(s: string | undefined, n: number): string {
    if (!s) return '';
    return s.length > n ? `${s.slice(0, n)}…` : s;
}
