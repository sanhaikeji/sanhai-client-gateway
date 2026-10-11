/**
 * 测试环境的准备脚本：把插件源码搬进 test/.build/，让 Node 能直接跑。
 *
 * 为什么要这一步：源码里的 import 写的是 `from './lib'`（不带扩展名，TS 的常规写法），
 * 而 Node 原生跑 TS 时要求写全 `./lib.ts`。所以这里复制一份、只改 import 路径，
 * **不动源码本身**（Hydro 的构建流程认的是不带扩展名的写法）。
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

// model.ts：只改 import 的解析路径 —— './lib' 补扩展名；mongodb 换成小替身
let m = readFileSync(join(SRC, 'model.ts'), 'utf8');
const before = m;
m = m.replace("from './lib'", "from './lib.ts'").replace("from 'mongodb'", "from './_oid.ts'");
if (m === before) {
    console.error('!! model.ts 的 import 没被替换 —— 检查源码里的写法是否变了');
    process.exit(1);
}
writeFileSync(join(OUT, 'model.ts'), m);

// ObjectId 替身（签到流程用不到它，只是让 import 成立）
writeFileSync(join(OUT, '_oid.ts'), [
    'export class ObjectId {',
    '    hex: string;',
    "    constructor(v?: string) { this.hex = v || '000000000000000000000000'; }",
    '    toString() { return this.hex; }',
    '}',
    '',
].join('\n'));

// 让 .build 下的 .ts 按 ESM 解析（否则 Node 当 CommonJS，import 直接语法错误）
writeFileSync(join(OUT, 'package.json'), '{ "type": "module" }\n');

console.log('测试环境已生成:', OUT);
