/**
 * OJ 数据类接口：题目、提交、比赛、讨论、排行榜。
 *
 * ⚠️ 这一组是**最容易跟 Hydro 版本打架**的地方 —— 各版本的
 * `ProblemModel.getMulti()` / `RecordModel.getMulti()` 返回类型和方法名都有出入。
 * 所以这里统一做了两件事：
 *   1. `toArray()` 兼容「返回游标」和「返回数组」两种；
 *   2. 模型方法调用失败时，**回退到直接读 MongoDB 集合**（Hydro 的数据就在
 *      `document` / `record` / `domain.user` 这几个集合里）。
 * 这样即便 Hydro 升级改了 API，接口也不会整个挂掉。
 */
import {
    ObjectId, PERM, ProblemModel, RecordModel, ContestModel, DiscussionModel, UserModel,
} from 'hydrooj';
import { ClientApiHandler } from './base';
import { resolveRecordScope } from '../lib';

/**
 * 取某个域下某个用户的权限对象（带 `hasPerm`）。
 *
 * ⚠️ **不能直接读 `domain.user` 集合** —— 原始文档上没有 `hasPerm` 方法，
 * 权限位（`perm` 与 `scope`）是 `UserModel.getById` 在加载时算好的。
 * 自己读集合再手工比位，等于把 Hydro 的角色继承/覆盖逻辑重写一遍，必错。
 */
async function domainUserOf(domainId: string, uid: number): Promise<any> {
    try {
        return await (UserModel as any).getById(domainId, uid);
    } catch {
        return null;
    }
}

/**
 * 判断某域下的用户有没有某个权限。
 *
 * <para>拿不到用户对象时一律返回 <c>false</c>（保守）—— 权限查询出错时宁可少给入口，
 * 也不要放行一个本该被拦的操作。</para>
 *
 * <para>⚠️ <c>hasPerm</c> 收的是 <b>bigint</b>（权限常量都是 `1n &lt;&lt; n`）。
 * 传 <c>undefined</c>（比如写错常量名）会在 `&amp;` 运算处直接抛 TypeError，
 * 整个接口 500 —— 所以**只用确实存在的 PERM 常量**。</para>
 */
async function hasPermOf(domainId: string, uid: number, perm: bigint): Promise<boolean> {
    const dudoc = await domainUserOf(domainId, uid);
    return !!dudoc && dudoc.hasPerm(perm);
}

/** 兼容：有的版本返回游标，有的返回数组。 */
async function toArray(x: any): Promise<any[]> {
    if (!x) return [];
    if (typeof x.toArray === 'function') return x.toArray();
    if (Array.isArray(x)) return x;
    if (typeof x[Symbol.asyncIterator] === 'function') {
        const out: any[] = [];
        for await (const v of x) out.push(v);
        return out;
    }
    return [];
}

const domainOf = (h: any) => String(h.domain?._id || 'system');

// ---------------------------------------------------------------- 题目

export class ProblemsHandler extends ClientApiHandler {
    protected async run() {
        const ctx: any = (this as any).ctx;
        const domainId = domainOf(this);
        const page = Math.max(1, this.intParam('page', 1));
        const limit = Math.min(100, Math.max(1, this.intParam('limit', 30)));
        const keyword = String(this.param('q', '')).trim();

        let total = 0;
        let rows: any[] = [];
        try {
            const query: any = {};
            if (keyword) query.$or = [
                { title: { $regex: keyword, $options: 'i' } },
                { docId: Number(keyword) },
            ];
            if (typeof (ProblemModel as any).getMulti === 'function') {
                rows = await toArray(await (ProblemModel as any).getMulti(domainId, query, [
                    'docId', 'title', 'difficulty', 'nSubmit', 'nAccept', 'tag',
                ]));
            }
            if (typeof (ProblemModel as any).count === 'function') {
                total = await (ProblemModel as any).count(domainId, query);
            } else total = rows.length;
        } catch {
            // 回退：直接读 document 集合（Hydro 的题目就存在这，docType=10）
            rows = await ctx.db.collection('document')
                .find({ domainId, docType: 10 }, { projection: { docId: 1, title: 1, nSubmit: 1, nAccept: 1, tag: 1 } })
                .sort({ docId: 1 }).toArray();
            total = rows.length;
        }

        const start = (page - 1) * limit;
        const slice = rows.slice(start, start + limit);
        this.ok({
            page, limit, total,
            problems: slice.map((p) => ({
                pid: p.docId,
                title: p.title,
                difficulty: p.difficulty ?? null,
                nSubmit: p.nSubmit ?? 0,
                nAccept: p.nAccept ?? 0,
                tags: p.tag || [],
            })),
        });
    }
}

export class ProblemDetailHandler extends ClientApiHandler {
    protected async run() {
        const domainId = domainOf(this);
        const pid = this.intParam('pid', 0);
        if (!pid) { this.fail('缺少题目号 pid'); return; }

        const pdoc = await toArray(await (ProblemModel as any).getMulti?.(domainId, { docId: pid }))
            .then((r) => r[0])
            .catch(() => null)
            || await (ProblemModel as any).get?.(domainId, pid).catch(() => null);
        if (!pdoc) { this.fail('题目不存在', 404); return; }

        this.ok({
            pid: pdoc.docId,
            title: pdoc.title,
            difficulty: pdoc.difficulty ?? null,
            nSubmit: pdoc.nSubmit ?? 0,
            nAccept: pdoc.nAccept ?? 0,
            tags: pdoc.tag || [],
            // 题面本身（Markdown）可以另外通过 /client-api/problem/statement 取，避免一次拉太多
            hasStatement: !!pdoc.content,
        });
    }
}

/** 随机一题（客户端首页「来一题」用）。 */
export class RandomProblemHandler extends ClientApiHandler {
    protected async run() {
        const ctx: any = (this as any).ctx;
        const domainId = domainOf(this);
        try {
            const rows = await ctx.db.collection('document')
                .aggregate([{ $match: { domainId, docType: 10 } }, { $sample: { size: 1 } }])
                .toArray();
            if (!rows.length) { this.fail('题库是空的', 404); return; }
            const p = rows[0];
            this.ok({ pid: p.docId, title: p.title });
        } catch {
            this.fail('取随机题目失败');
        }
    }
}

// ---------------------------------------------------------------- 提交记录

export class RecordsHandler extends ClientApiHandler {
    protected async run() {
        const ctx: any = (this as any).ctx;
        const domainId = domainOf(this);
        const limit = Math.min(100, Math.max(1, this.intParam('limit', 20)));
        const page = Math.max(1, this.intParam('page', 1));
        const mine = String(this.param('mine', '0')) === '1';
        const pid = this.intParam('pid', 0);
        let uid = mine ? this.clientUid : this.intParam('uid', 0);

        // 状态筛选：不传 = 全部；传 1 = 只看 AC（Hydro 的 STATUS.ACCEPTED）。
        const statusRaw = String(this.param('status', '')).trim();
        const status = statusRaw === '' ? null : Number(statusRaw);

        // ---- 权限门（与 Hydro 网页端同一条规则）----
        //
        // ⚠️⚠️ Hydro 在 `handler/record.ts` 里是这么写的：
        //       `if (q.uid !== this.user._id) this.checkPerm(PERM.PERM_VIEW_RECORD);`
        //    也就是说「查别人的、或不带 uid 查全部」都要 PERM_VIEW_RECORD。
        //    客户端入口**必须复刻这条**，而且要更小心：网页端的 uid 来自 query，
        //    Hydro 自己会拦；而这里是令牌接口，**不拦就是任何人改个 uid 就看全站提交**。
        const canViewAll = await hasPermOf(domainId, this.clientUid, PERM.PERM_VIEW_RECORD);
        // 决策本身是个纯函数（lib.resolveRecordScope），测试直接打它 ——
        // 保证「测过的」和「线上跑的」是同一段逻辑，不会各写一份走偏。
        const scope = resolveRecordScope({ mine, uid, clientUid: this.clientUid, canViewAll });
        if (scope.deny) {
            this.fail('没有查看他人提交记录的权限', 403);
            return;
        }
        uid = scope.uid;

        const query: any = {};
        if (uid) query.uid = uid;
        if (pid) query.pid = pid;
        if (status !== null && Number.isFinite(status)) query.status = status;

        let rows: any[] = [];
        try {
            rows = await toArray(await (RecordModel as any).getMulti(domainId, query, {
                limit: limit * page, sort: { _id: -1 },
            }));
        } catch {
            // 回退：直接读 record 集合
            const q: any = {};
            if (uid) q.uid = uid;
            if (pid) q.pid = pid;
            if (status !== null && Number.isFinite(status)) q.status = status;
            rows = await ctx.db.collection('record').find(q)
                .sort({ _id: -1 }).limit(limit * page).toArray();
        }
        const slice = rows.slice((page - 1) * limit, page * limit);
        this.ok({
            page, limit,
            // 给客户端判断「要不要显示『本题全部提交 / 只看 AC』那两个按钮」
            canViewAll,
            uidScope: uid || 0,
            pidScope: pid || 0,
            statusScope: status === null ? null : status,
            records: slice.map((r) => ({
                rid: String(r._id),
                pid: r.pid,
                uid: r.uid,
                lang: r.lang,
                status: r.status,
                score: r.score,
                time: r.time,
                memory: r.memory,
                at: r._id?.getTimestamp?.() || null,
            })),
        });
    }
}

export class RecordDetailHandler extends ClientApiHandler {
    protected async run() {
        const ctx: any = (this as any).ctx;
        const domainId = domainOf(this);
        const rid = String(this.param('rid', '')).trim();
        if (!rid) { this.fail('缺少评测记录号 rid'); return; }

        let rdoc: any = null;
        try {
            rdoc = await (RecordModel as any).get?.(domainId, rid);
        } catch { /* 回退 */ }
        if (!rdoc) {
            try {
                rdoc = await ctx.db.collection('record').findOne({ _id: new ObjectId(rid) });
            } catch { /* 真找不到 */ }
        }
        if (!rdoc) { this.fail('评测记录不存在', 404); return; }

        // ---- 能不能看这条记录本身 ----
        // 和 Hydro 网页端同一条规则：不是自己的记录，就要 PERM_VIEW_RECORD。
        const isSelf = rdoc.uid === this.clientUid;
        if (!isSelf && !await hasPermOf(domainId, this.clientUid, PERM.PERM_VIEW_RECORD)) {
            this.fail('没有查看他人提交记录的权限', 403);
            return;
        }

        // ---- 能不能看代码 ----
        // 自己看自己 → 可以；
        // 看别人的 → 要有 PERM_READ_RECORD_CODE（这就是「按题目查看 AC 和所有提交」里
        //   那个能看代码的权限）；只 AC 代码则是 PERM_READ_RECORD_CODE_ACCEPT。
        let canSeeCode = isSelf;
        if (!canSeeCode) {
            canSeeCode = await hasPermOf(domainId, this.clientUid, PERM.PERM_READ_RECORD_CODE);
            if (!canSeeCode && rdoc.status === 1) {
                canSeeCode = await hasPermOf(domainId, this.clientUid, PERM.PERM_READ_RECORD_CODE_ACCEPT);
            }
        }

        this.ok({
            rid: String(rdoc._id),
            pid: rdoc.pid,
            uid: rdoc.uid,
            lang: rdoc.lang,
            status: rdoc.status,
            score: rdoc.score,
            time: rdoc.time,
            memory: rdoc.memory,
            isSelf,
            canSeeCode,
            // 只在有权限时返回代码，否则给空串（避免拿客户端抄代码）
            code: canSeeCode ? rdoc.code : '',
            compilerTexts: rdoc.compilerTexts || [],
            testCases: (rdoc.testCases || []).map((t: any) => ({
                id: t.id, status: t.status, time: t.time, memory: t.memory, score: t.score,
                message: t.message || '',
            })),
        });
    }
}

// ---------------------------------------------------------------- 域内权限

/**
 * 当前账号在**当前域**有什么权限。
 *
 * <para>为什么必须做成接口：客户端原来判「能不能建题」是去 GET
 * <c>/d/{domain}/problem/create</c> 然后**在返回的 HTML/JSON 里找关键字**
 * <c>problem_create</c>。这个做法在两个地方会失效：</para>
 * <list type="number">
 *   <item>各版本返回的文案不一样，关键字一改就永远判成「没权限」；</item>
 *   <item>更关键的是它**没有跟着域走** —— 权限是<b>按域</b>算的，
 *         同一账号在 A 域是出题人、在 B 域只是普通用户，网页端会各显各的，
 *         而客户端只在登录时探一次，切域不重探 → 「在有的域里建题功能没了」。</item>
 * </list>
 *
 * <para>这里直接用 Hydro 自己的 <c>UserModel.getById(domainId, uid).hasPerm()</c>，
 * 判据和网页端完全一致，不猜任何字符串。</para>
 */
export class PermsHandler extends ClientApiHandler {
    protected async run() {
        const domainId = domainOf(this);
        const dudoc = await domainUserOf(domainId, this.clientUid);
        const has = (p: bigint) => !!dudoc && dudoc.hasPerm(p);

        this.ok({
            domainId,
            uid: this.clientUid,
            role: String((dudoc as any)?.role || ''),
            // 题目
            createProblem: has(PERM.PERM_CREATE_PROBLEM),
            editProblem: has(PERM.PERM_EDIT_PROBLEM),
            editProblemSelf: has(PERM.PERM_EDIT_PROBLEM_SELF),
            viewProblemHidden: has(PERM.PERM_VIEW_PROBLEM_HIDDEN),
            submitProblem: has(PERM.PERM_SUBMIT_PROBLEM),
            // 提交记录
            viewRecord: has(PERM.PERM_VIEW_RECORD),
            readRecordCode: has(PERM.PERM_READ_RECORD_CODE),
            readRecordCodeAccept: has(PERM.PERM_READ_RECORD_CODE_ACCEPT),
            rejudge: has(PERM.PERM_REJUDGE),
            // 讨论
            createDiscussion: has(PERM.PERM_CREATE_DISCUSSION),
        });
    }
}

// ---------------------------------------------------------------- 提交代码

export class SubmitHandler extends ClientApiHandler {
    protected async run() {
        const pid = this.intParam('pid', 0);
        const lang = String(this.param('lang', '')).trim();
        const code = String(this.param('code', ''));
        if (!pid) { this.fail('缺少题目号 pid'); return; }
        if (!lang) { this.fail('缺少语言 lang'); return; }
        if (!code.trim()) { this.fail('代码是空的'); return; }

        const rid = await submitCode(domainOf(this), pid, this.clientUid, lang, code);
        this.ok({ rid, message: '已提交，正在等待评测' });
    }
}

/**
 * 建立一条提交记录。
 *
 * ⚠️ Hydro 的提交入口各版本不一样，这里按可能性依次尝试，并且把**实际用上的那个**
 * 一起返回 —— 万一哪天都对不上，客户端能拿到明确原因，而不是一个「提交失败」。
 */
async function submitCode(domainId: string, pid: number, uid: number, lang: string, code: string): Promise<string> {
    const P: any = ProblemModel;
    const R: any = RecordModel;
    const attempts: Array<[string, () => Promise<any>]> = [
        ['ProblemModel.submit', () => P.submit?.(domainId, pid, uid, lang, code)],
        ['ProblemModel.submit2', () => P.submit?.(domainId, pid, lang, code, uid)],
        ['RecordModel.add', () => R.add?.(domainId, pid, uid, lang, code)],
        ['RecordModel.add2', () => R.add?.(domainId, pid, lang, code, uid)],
    ];
    const errs: string[] = [];
    for (const [name, fn] of attempts) {
        try {
            const rid = await fn();
            if (rid) return String(rid);
        } catch (e) {
            errs.push(`${name}: ${(e as Error).message}`);
        }
    }
    throw new Error(`提交失败：这个 Hydro 版本没有可用的提交入口。已尝试 ${errs.join(' | ') || '（方法不存在）'}`);
}

// ---------------------------------------------------------------- 比赛

export class ContestsHandler extends ClientApiHandler {
    protected async run() {
        const domainId = domainOf(this);
        let rows: any[] = [];
        try {
            rows = await toArray(await (ContestModel as any).getMulti(domainId, {}));
        } catch {
            const ctx: any = (this as any).ctx;
            rows = await ctx.db.collection('document')
                .find({ domainId, docType: 20 }, { projection: { docId: 1, title: 1, beginAt: 1, endAt: 1, rule: 1 } })
                .sort({ beginAt: -1 }).limit(50).toArray();
        }
        const now = Date.now();
        this.ok({
            contests: rows.slice(0, 50).map((c) => ({
                tid: c.docId,
                title: c.title,
                beginAt: c.beginAt || null,
                endAt: c.endAt || null,
                rule: c.rule || '',
                phase: c.beginAt && c.endAt
                    ? (now < new Date(c.beginAt).getTime() ? 'upcoming'
                        : now > new Date(c.endAt).getTime() ? 'ended' : 'running')
                    : '',
            })),
        });
    }
}

// ---------------------------------------------------------------- 讨论

export class DiscussionsHandler extends ClientApiHandler {
    protected async run() {
        const domainId = domainOf(this);
        let rows: any[] = [];
        try {
            rows = await toArray(await (DiscussionModel as any).getMulti(domainId, {}));
        } catch {
            const ctx: any = (this as any).ctx;
            rows = await ctx.db.collection('document')
                .find({ domainId, docType: { $in: [30, 31] } },
                    { projection: { docId: 1, title: 1, owner: 1, nReply: 1, updateAt: 1 } })
                .sort({ updateAt: -1 }).limit(50).toArray();
        }
        this.ok({
            discussions: rows.slice(0, 50).map((d) => ({
                did: d.docId,
                title: d.title,
                owner: d.owner,
                nReply: d.nReply ?? 0,
                updateAt: d.updateAt || null,
            })),
        });
    }
}

// ---------------------------------------------------------------- 排行榜

export class RankingHandler extends ClientApiHandler {
    protected async run() {
        const ctx: any = (this as any).ctx;
        const domainId = domainOf(this);
        const limit = Math.min(200, Math.max(1, this.intParam('limit', 50)));
        const rows = await ctx.db.collection('domain.user')
            .find({ domainId }, { projection: { uid: 1, rp: 1, nAccept: 1, nSubmit: 1, displayName: 1 } })
            .sort({ rp: -1 }).limit(limit).toArray();

        const uids = rows.map((r: any) => r.uid);
        let names: Record<number, string> = {};
        try {
            const users = await ctx.db.collection('user')
                .find({ _id: { $in: uids } }, { projection: { uname: 1 } }).toArray();
            names = Object.fromEntries(users.map((u: any) => [u._id, u.uname]));
        } catch { /* 没名字也能显示 uid */ }

        this.ok({
            ranking: rows.map((r: any, i: number) => ({
                rank: i + 1,
                uid: r.uid,
                uname: names[r.uid] || `uid:${r.uid}`,
                displayName: r.displayName || names[r.uid] || '',
                rp: r.rp ?? 0,
                nAccept: r.nAccept ?? 0,
                nSubmit: r.nSubmit ?? 0,
            })),
        });
    }
}
