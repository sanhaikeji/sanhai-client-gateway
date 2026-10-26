/**
 * 测试环境的准备脚本：把插件源码搬进 test/.build/，让 Node 能直接跑。
 *
 * 为什么要这一步：源码里的 import 写的是 `from './lib'`（不带扩展名，TS 的常规写法），
 * 而 Node 原生跑 TS 时要求写全 `./lib.ts`。另外 `hydrooj` 是服务器上才有的包，
 * 本机没有 —— 所以要把它换成一个只提供 `ObjectId` 的小替身。
 * **只改副本，不动源码本身**（Hydro 的构建流程认的是不带扩展名的写法）。
 *
 * 用法：
 *     node test/prepare.mjs && node --experimental-strip-types test/test.ts
 */
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');
const OUT = join(here, '.build');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// lib.ts 原样搬（只依赖 node 内置的 crypto）
copyFileSync(join(SRC, 'lib.ts'), join(OUT, 'lib.ts'));

// notify.ts 原样搬（纯函数，不 import 任何东西）
copyFileSync(join(SRC, 'notify.ts'), join(OUT, 'notify.ts'));

// model.ts：把解析路径改成本机能跑的 —— './lib' 补扩展名，'hydrooj' 换成小替身
let m = readFileSync(join(SRC, 'model.ts'), 'utf8');
const before = m;
m = m.replaceAll("from './lib'", "from './lib.ts'");
m = m.replaceAll("from 'hydrooj'", "from './_hydro.ts'");
if (m === before) {
    console.error('!! model.ts 的 import 没被替换 —— 检查源码里的写法是否变了');
    process.exit(1);
}
if (!m.includes("./_hydro.ts")) {
    console.error('!! model.ts 没有从 hydrooj 导入任何东西 —— 检查是否漏了 ObjectId');
    process.exit(1);
}
writeFileSync(join(OUT, 'model.ts'), m);

// points.ts：积分 / 任务 / 打卡能量（新加的积分数值要能单独测）
let p = readFileSync(join(SRC, 'points.ts'), 'utf8');
p = p.replaceAll("from 'hydrooj'", "from './_hydro.ts'");
p = p.replaceAll("from './model'", "from './model.ts'");
p = p.replaceAll("from './lib'", "from './lib.ts'");
writeFileSync(join(OUT, 'points.ts'), p);

// hydrooj 替身：只提供源码真正用到的值
writeFileSync(join(OUT, '_hydro.ts'), [
    '/** 服务器上是真 hydrooj；本机测试只要 import 成立即可。 */',
    'export class ObjectId {',
    '    hex: string;',
    "    constructor(v?: string) { this.hex = v || '000000000000000000000000'; }",
    '    toString() { return this.hex; }',
    '}',
    '',
    '/** base.ts 里 `extends Handler` 用；测试直接调 run()，不走框架生命周期。 */',
    'export class Handler { async prepare() {} }',
    '',
    '/** 权限常量在真 hydrooj 里是 bigint；这里必须也是 bigint（number 会在 `&` 处抛）。 */',
    'export const PERM: any = new Proxy({}, {',
    '    get: (t: any, k: string) => (typeof k === "string" && k.startsWith("PERM_") ? 1n << 1n : undefined),',
    '});',
    '',
    '/** 题目模型：测试会直接改这些方法（同一模块实例，改了 oj.ts 里就看得见）。 */',
    'export const ProblemModel: any = { getMulti: async () => [], get: async () => null };',
    'export const RecordModel: any = { get: async () => null, getMulti: async () => [] };',
    'export const ContestModel: any = { getMulti: async () => [] };',
    'export const DiscussionModel: any = { getMulti: async () => [] };',
    'export const UserModel: any = { getById: async () => null };',
    '',
].join('\n'));

// handler 层：搬通知 / 硬币 / 签到 / 题目，供 test.ts 直接跑
// **真实的 handler 代码路径** —— 查询条件对不对、返回体对不对、权限门在不在，都在这里验。
mkdirSync(join(OUT, 'handler'), { recursive: true });
for (const f of ['base.ts', 'coin.ts', 'system.ts', 'checkin.ts', 'oj.ts']) {
    let code = readFileSync(join(SRC, 'handler', f), 'utf8');
    code = code.replaceAll("from 'hydrooj'", "from '../_hydro.ts'");
    for (const dep of ['base', 'coin']) code = code.replaceAll(`from './${dep}'`, `from './${dep}.ts'`);
    for (const dep of ['model', 'lib', 'notify', 'points']) {
        code = code.replaceAll(`from '../${dep}'`, `from '../${dep}.ts'`);
    }
    writeFileSync(join(OUT, 'handler', f), code);
}

// 让 .build 下的 .ts 按 ESM 解析（否则 Node 当 CommonJS，import 直接语法错误）
writeFileSync(join(OUT, 'package.json'), '{ "type": "module" }\n');

console.log('测试环境已生成:', OUT);
