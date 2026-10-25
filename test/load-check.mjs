/**
 * 「真加载 + 真注册」测试。
 *
 * 为什么需要它：`test.ts` 只跑 model/lib 的逻辑，**碰不到 index.ts 和各 handler**。
 * 而实际踩过的两个坑都属于「加载阶段」，逻辑测试完全发现不了：
 *   1) `import { ObjectId } from 'mongodb'` —— 插件装在 ~/.hydro/addons/ 下时，
 *      从那里往上找不到 mongodb 的 node_modules，require 直接抛错；
 *      而 Hydro 的三个加载器**共用同一个 fail 列表**，一个文件炸了，
 *      整个插件的 index.ts（42 条路由）都会被跳过 → 表现成**全部 404**。
 *   2) `import { TokenInfo } from '../model'` —— TokenInfo 是 interface，
 *      当值导入在 ESM 下是硬错误（does not provide an export named）。
 * 这两类只有**真 import 一遍**才能发现，所以有了这个测试。
 *
 * 做法：造个临时目录，放一个 `node_modules/hydrooj` 替身，把源码按真实结构拷进去
 * （只把相对 import 补上 `.ts` —— Node 原生跑 TS 要求写全，Hydro 不需要），
 * 然后真的 import index.ts、真的调 apply()，数注册了多少条路由。
 *
 * 用法（注意要带 --experimental-strip-types）：
 *     node --experimental-strip-types test/load-check.mjs
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');
const OUT = join(here, '.build-load');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'node_modules', 'hydrooj'), { recursive: true });
mkdirSync(join(OUT, 'plugin', 'handler'), { recursive: true });

// ---------- 1) hydrooj 替身 ----------
// 服务器上这里是真的 hydrooj（package.json 的 main = src/plugin-api）。
// 替身只保证「名字都存在」—— 名字对不上就会像真环境一样抛错，这正是我们要测的。
writeFileSync(join(OUT, 'node_modules', 'hydrooj', 'package.json'),
    JSON.stringify({ name: 'hydrooj', version: '0.0.0-stub', main: 'index.js', type: 'module' }, null, 2));
writeFileSync(join(OUT, 'node_modules', 'hydrooj', 'index.js'), `
export class Context {}
export class Handler { async prepare() {} }
export class ObjectId { constructor(v) { this.hex = v || '0'.repeat(24); } toString() { return this.hex; } }
// Schema 是链式 API（Schema.object({...}).default(...)），替身必须也能一路链下去，
// 否则报的是替身的错、不是插件的错（踩过一次：".default is not a function"）。
// 注意：方法必须返回**代理自己**（返回普通对象的话链就断了 —— 上面那个 .default 报错就是这么来的）。
let SchemaStub;
SchemaStub = new Proxy(function () {}, {
    get: (t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : () => SchemaStub),
    apply: () => SchemaStub,
});
export const Schema = SchemaStub;
export const PRIV = { PRIV_USER_PROFILE: 1, PRIV_EDIT_SYSTEM: 2, PRIV_CREATE_DOMAIN: 4, PRIV_ALL: 8 };
// ⚠️ 权限常量在真 hydrooj 里是 **BigInt**（形如 1n 左移 n 位）。替身也必须给 BigInt ——
//    给成 number 的话按位与在真环境里会抛
//    "Cannot mix BigInt and other types"，而替身下却能跑过，等于白测。
export const PERM = {
    PERM_VIEW: 1n << 0n,
    PERM_CREATE_PROBLEM: 1n << 4n,
    PERM_EDIT_PROBLEM: 1n << 5n,
    PERM_EDIT_PROBLEM_SELF: 1n << 6n,
    PERM_VIEW_PROBLEM: 1n << 7n,
    PERM_VIEW_PROBLEM_HIDDEN: 1n << 8n,
    PERM_SUBMIT_PROBLEM: 1n << 9n,
    PERM_READ_PROBLEM_DATA: 1n << 10n,
    PERM_VIEW_RECORD: 1n << 70n,
    PERM_READ_RECORD_CODE: 1n << 12n,
    PERM_READ_RECORD_CODE_ACCEPT: 1n << 66n,
    PERM_REJUDGE_PROBLEM: 1n << 13n,
    PERM_REJUDGE: 1n << 14n,
    PERM_CREATE_DISCUSSION: 1n << 28n,
    PERM_VIEW_DISCUSSION: 1n << 27n,
};
export const UserModel = { getById: async () => null, getByUname: async () => null, getByEmail: async () => null };
export const ProblemModel = { getMulti: async () => [] };
export const RecordModel = { get: async () => null };
export const ContestModel = { getMulti: async () => [] };
export const DiscussionModel = { getMulti: async () => [] };
`);

// ---------- 2) 拷源码，只把相对 import 补成带 .ts（目录要补 index.ts） ----------
const files = ['index.ts', 'lib.ts', 'notify.ts', 'model.ts', 'points.ts',
    ...readdirSync(join(SRC, 'handler')).filter((f) => f.endsWith('.ts')).map((f) => `handler/${f}`)];

function fixImports(code, fileDir) {
    return code.replace(/from\s+'(\.{1,2}\/[^']*)'/g, (whole, spec) => {
        if (spec.endsWith('.ts')) return whole;
        const abs = resolve(fileDir, spec);
        if (existsSync(`${abs}.ts`)) return `from '${spec}.ts'`;
        if (existsSync(abs) && statSync(abs).isDirectory() && existsSync(join(abs, 'index.ts'))) {
            return `from '${spec}/index.ts'`;
        }
        return whole;
    });
}

for (const f of files) {
    const dst = join(OUT, 'plugin', f);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, fixImports(readFileSync(join(SRC, f), 'utf8'), dirname(join(SRC, f))));
}
writeFileSync(join(OUT, 'plugin', 'package.json'), '{ "type": "module" }\n');

// ---------- 3) 真 import + 真 apply ----------
const coll = {
    createIndex: async () => ({}),
    findOne: async () => null,
    find: () => ({
        toArray: async () => [],
        sort: () => ({ limit: () => ({ toArray: async () => [] }), toArray: async () => [] }),
        limit: () => ({ toArray: async () => [] }),
    }),
    updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 }),
    updateMany: async () => ({ matchedCount: 0, modifiedCount: 0 }),
    insertOne: async () => ({ insertedId: 1 }),
    aggregate: () => ({ toArray: async () => [] }),
};
const routes = [];
const ctx = {
    Route: (name, path) => routes.push({ name, path }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    db: { collection: () => coll },
    setting: { get: () => undefined },
    on: () => {}, inject: () => {}, plugin: () => {},
};

let apply;
try {
    ({ apply } = await import(pathToFileURL(join(OUT, 'plugin', 'index.ts')).href));
} catch (e) {
    console.error('✗ 插件加载失败 —— 线上就会表现成全部 404\n');
    console.error(e);
    process.exit(1);
}

try {
    await apply(ctx, {});
} catch (e) {
    console.error('✗ apply() 抛异常 —— 路由注册到一半就断了\n');
    console.error(e);
    process.exit(1);
}

console.log('注册到的路由：');
for (const r of routes) console.log('  ' + r.path);
if (routes.length !== 42) {
    console.error(`\n✗ 期望 42 条路由，实际 ${routes.length} 条`);
    process.exit(1);
}
console.log(`\n✓ 插件加载成功，注册了 ${routes.length} 条路由`);
process.exit(0);
