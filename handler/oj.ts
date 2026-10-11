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
import { ProblemModel, RecordModel, ContestModel, DiscussionModel } from 'hydrooj';
import { ClientApiHandler } from './base';

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
        const uid = mine ? this.clientUid : this.intParam('uid', 0);

        const query: any = {};
        if (uid) query.uid = uid;
        if (pid) query.pid = pid;

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
            rows = await ctx.db.collection('record').find(q)
                .sort({ _id: -1 }).limit(limit * page).toArray();
        }
        const slice = rows.slice((page - 1) * limit, page * limit);
        this.ok({
            page, limit,
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
        const rid = String(this.param('rid', '')).trim();
        if (!rid) { this.fail('缺少评测记录号 rid'); return; }

        let rdoc: any = null;
        try {
            rdoc = await (RecordModel as any).get?.(domainOf(this), rid);
        } catch { /* 回退 */ }
        if (!rdoc) {
            try {
                const { ObjectId } = await import('mongodb');
                rdoc = await ctx.db.collection('record').findOne({ _id: new ObjectId(rid) });
            } catch { /* 真找不到 */ }
        }
        if (!rdoc) { this.fail('评测记录不存在', 404); return; }

        this.ok({
            rid: String(rdoc._id),
            pid: rdoc.pid,
            uid: rdoc.uid,
            lang: rdoc.lang,
            status: rdoc.status,
            score: rdoc.score,
            time: rdoc.time,
            memory: rdoc.memory,
            // 只在「自己看自己」时返回代码，别人看别人的不给（避免拿客户端抄代码）
            code: rdoc.uid === this.clientUid ? rdoc.code : '',
            compilerTexts: rdoc.compilerTexts || [],
            testCases: (rdoc.testCases || []).map((t: any) => ({
                id: t.id, status: t.status, time: t.time, memory: t.memory, score: t.score,
                message: t.message || '',
            })),
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
