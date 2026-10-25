/**
 * 私信「已读」的规则 —— 纯函数，handler 和测试共用同一份，避免两边各写一套查询。
 *
 * 为什么不能沿用老的 `$set: { read: true }`：
 * <para>`message.to` 可以是**数组**（一条消息同时发给多个人），而一条消息只有**一份文档**。
 * 老写法下 A 点开私信 = 把文档上的 `read` 置真 = B 那边的未读数凭空消失，
 * 这就是「一台设备读了、另一台设备也跟着读了」的根因。</para>
 *
 * <para>所以已读必须**按收件人**记在消息文档上：`readBy: { "<uid>": ISODate }`。
 * 状态跟着 uid 走，天然跨设备一致（换台电脑登录同一个号，已读还是已读）。</para>
 *
 * <para>老数据兼容：老插件只写 `read: true`、没有 `readBy`。若按新规则一刀切，
 * 升级后所有历史消息都会变回未读（用户看到的是「未读数突然暴涨」）。
 * 因此 `read === true` 仍然算「所有人都已读」。</para>
 */

/** 已读表在消息文档上的字段名。 */
export const READ_BY = 'readBy';

/**
 * 把 uid 规整成安全的数字。
 *
 * <para>uid 来自令牌（正常一定是整数），这里防的是脏数据：万一拼进一个带点号/美元符的
 * 字符串，查询路径就成了攻击者可控的字段名。数字化之后只剩 `[0-9]`。</para>
 */
function uidKey(uid: number): string {
    const n = Number(uid);
    if (!Number.isFinite(n) || n <= 0) throw new Error('uid 不合法');
    return String(Math.trunc(n));
}

/**
 * 「我还没读的」查询条件。
 *
 * <para>⚠️ 点号路径必须用**计算键名的对象字面量**写（`{ [`readBy.${uid}`]: ... }`），
 * 不能手拼查询字符串 —— 手拼既可能被注入，也会让 `readBy.5` 被当成字面字段名而永远匹配不到。</para>
 *
 * <para>三个条件缺一不可：`to: uid` 限定我是收件人、`readBy.<uid>` 不存在 = 我没读过、
 * `read !== true` 放过老数据的全局已读。</para>
 */
export function unreadFilter(uid: number) {
    const key = `${READ_BY}.${uidKey(uid)}`;
    return {
        to: Number(uid),
        [key]: { $exists: false },
        read: { $ne: true },
    };
}

/** 标记「我」已读要写的更新体：只动 `readBy.<uid>` 这一格，别人的格子原样不动。 */
export function readMark(uid: number, at: Date = new Date()) {
    return { $set: { [`${READ_BY}.${uidKey(uid)}`]: at } };
}

/** 我从这条消息里读到的已读时间；没读过返回 null（老数据的 `read: true` 没时间，也返回 null）。 */
export function readAtOf(m: any, uid: number): Date | null {
    const v = m?.[READ_BY]?.[uidKey(uid)];
    return v ? new Date(v) : null;
}

/** 「我」是否已读：有我的 `readBy` 记录，或老数据说这条已读（`read === true`）。 */
export function isReadBy(m: any, uid: number): boolean {
    const v = m?.[READ_BY]?.[uidKey(uid)];
    if (v !== undefined && v !== null) return true;
    return m?.read === true;
}
