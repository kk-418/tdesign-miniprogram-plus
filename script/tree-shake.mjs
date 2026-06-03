#!/usr/bin/env node
/**
 * tree-shake.mjs — 组件依赖闭包裁剪（物理 tree-shaking）
 *
 * 把全量 tdesign-miniprogram(-plus) dist 按某个下游小程序 app 实际用到的组件做物理裁剪，
 * 删掉未被引用的组件目录与开发期冗余文件，减小 miniprogram_npm 包体积。
 *
 * 背景：app.json 即使开启 lazyCodeLoading:"requiredComponents" 也只优化启动注入、不减包体积，
 * 所以必须物理删文件。
 *
 * 用法：
 *   node script/tree-shake.mjs --app <appMiniprogramDir> --dist <distDir> [--dry-run]
 *
 *   --app      下游小程序源码根目录（含 app.json / pages / components 的 .json）
 *   --dist     要裁剪的 tdesign dist 目录（原地删文件）
 *   --dry-run  只打印将删除/保留清单，不真正删
 *
 * 算法：
 *   1. 求根集：扫描 app 下所有 .json（排除其 miniprogram_npm/）的 usingComponents /
 *      componentGenerics，凡 value 解析后落在 dist 内的，取其顶层组件目录名为根。
 *   2. BFS 求传递闭包：读 dist 内组件 json 的 usingComponents/componentGenerics，
 *      把指向其它 tdesign 组件的相对路径解析进集合，迭代到不动点。
 *   3. 始终保留共享目录：common / mixins / locale / config-provider。
 *   4. 内嵌依赖：扫描"保留组件目录 + 共享目录"内的 @import(wxss) / <wxs src>(wxml) /
 *      require|import(js) 对 dist 根下其它顶层目录/文件（含 miniprogram_npm/<lib>）的引用，
 *      被引用项加入保留集，迭代到不动点（保守：宁可多留不可错删）。
 *      其中 common/shared/<name> 子目录视为组件 <name> 的私有共享代码，仅当 <name> 被保留时才保留。
 *   5. 删除 dist 顶层中不在保留集的目录；删除开发期冗余文件（.wechatide.ib.json）；
 *      保留 dist 根下的 .json/索引/注册清单等工具文件。
 *
 * 仅用 Node 内置模块，node 直接可跑。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// CLI 解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { app: '', dist: '', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--app') args.app = argv[++i];
    else if (a === '--dist') args.dist = argv[++i];
    else if (a === '--dry-run' || a === '--dryRun') args.dryRun = true;
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function usage() {
  console.log(
    'Usage: node script/tree-shake.mjs --app <appMiniprogramDir> --dist <distDir> [--dry-run]',
  );
}

// 始终保留的共享目录（顶层目录名）
const ALWAYS_KEEP = new Set(['common', 'mixins', 'locale', 'config-provider']);

// dist 根下永远保留的工具文件（注册清单 / 入口 / 类型）
const ROOT_KEEP_FILE_EXT = new Set(['.json', '.js', '.ts', '.map', '.wxs', '.wxss']);

// 开发期冗余文件名（位于任意层级，删除）
const REDUNDANT_FILE_NAMES = new Set(['.wechatide.ib.json']);

// 内嵌 npm 容器目录名
const EMBED_NPM_DIR = 'miniprogram_npm';

const log = (...m) => console.log(...m);
const warn = (...m) => console.warn('[warn]', ...m);

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 递归列出目录下所有文件（绝对路径），可传入需跳过的绝对目录集合 */
function walkFiles(root, skipDirs = new Set()) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(full)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    warn(`解析 JSON 失败，跳过：${file} (${err.message})`);
    return null;
  }
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function dirSizeBytes(p) {
  let total = 0;
  if (isDir(p)) {
    for (const f of walkFiles(p)) {
      try {
        total += fs.statSync(f).size;
      } catch {
        /* ignore */
      }
    }
  } else {
    try {
      total += fs.statSync(p).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}
const kb = (bytes) => (bytes / 1024).toFixed(1);

/**
 * 给定 dist 内某个引用路径（usingComponents/generics 的 value、或源码内 import 的相对路径），
 * 返回它落在 dist 内的"顶层条目名"（顶层目录或顶层文件，去掉后续路径）。
 * fromFile：发起引用的文件绝对路径（用于解析相对路径）。
 * 返回 null 表示该引用不落在 dist 内（外部包、网络组件等）。
 */
function resolveTopLevelEntry(distRoot, fromFile, ref) {
  if (!ref || typeof ref !== 'string') return null;
  // 去掉协议/网络组件占位
  if (ref.startsWith('plugin://') || ref.startsWith('plugin-private://')) return null;

  // 显式带库名前缀：.../tdesign-miniprogram-plus/<comp>/...
  const marker = 'tdesign-miniprogram-plus/';
  const mi = ref.indexOf(marker);
  if (mi !== -1) {
    const rest = ref.slice(mi + marker.length);
    return firstSegment(rest);
  }

  let abs;
  if (ref.startsWith('/')) {
    // 小程序绝对路径（相对 app 根）——通常不指向 dist，但若文本恰好是 dist 内绝对路径也兼容
    if (ref.startsWith(distRoot + path.sep) || ref === distRoot) {
      abs = ref;
    } else {
      return null;
    }
  } else if (ref.startsWith('.')) {
    abs = path.resolve(path.dirname(fromFile), ref);
  } else {
    // 裸标识符：可能是内嵌 npm 包（dayjs / tslib / marked ...）
    const bareTop = firstSegment(ref);
    const embedded = path.join(distRoot, EMBED_NPM_DIR, bareTop);
    if (exists(embedded) || exists(embedded + '.js')) {
      return `${EMBED_NPM_DIR}/${bareTop}`;
    }
    return null;
  }

  const normDist = path.resolve(distRoot);
  const normAbs = path.resolve(abs);
  if (normAbs !== normDist && !normAbs.startsWith(normDist + path.sep)) return null;

  const rel = path.relative(normDist, normAbs);
  if (!rel || rel.startsWith('..')) return null;
  // 内嵌 npm：保留到二级（miniprogram_npm/<lib>）
  const segs = rel.split(path.sep);
  if (segs[0] === EMBED_NPM_DIR && segs.length >= 2) {
    return `${EMBED_NPM_DIR}/${segs[1]}`;
  }
  return segs[0];
}

function firstSegment(p) {
  const clean = p.replace(/^[./]+/, '');
  const seg = clean.split('/')[0];
  return seg || null;
}

// ---------------------------------------------------------------------------
// 步骤 1：从 app 求根集（入口组件）
// ---------------------------------------------------------------------------
function collectRootComponents(appDir, distRoot) {
  const roots = new Set();
  const skip = new Set([path.join(appDir, EMBED_NPM_DIR)]);
  const jsonFiles = walkFiles(appDir, skip).filter((f) => f.endsWith('.json'));

  for (const jf of jsonFiles) {
    const json = readJsonSafe(jf);
    if (!json || typeof json !== 'object') continue;
    for (const ref of extractComponentRefs(json)) {
      const top = resolveTopLevelEntry(distRoot, jf, ref);
      if (top) roots.add(top);
    }
  }
  return roots;
}

/** 从一份 json 里抽取所有组件引用 value（usingComponents + componentGenerics 默认值） */
function extractComponentRefs(json) {
  const refs = [];
  const uc = json.usingComponents;
  if (uc && typeof uc === 'object') {
    for (const v of Object.values(uc)) if (typeof v === 'string') refs.push(v);
  }
  const cg = json.componentGenerics;
  if (cg && typeof cg === 'object') {
    for (const v of Object.values(cg)) {
      // generics 可能是 true 或 { default: "path" }
      if (v && typeof v === 'object' && typeof v.default === 'string') refs.push(v.default);
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// 步骤 2：BFS 传递闭包（组件 → 组件，经 dist 内组件 json）
// ---------------------------------------------------------------------------
function expandComponentClosure(distRoot, roots) {
  const kept = new Set([...roots].filter((r) => !r.startsWith(`${EMBED_NPM_DIR}/`)));
  const queue = [...kept];
  while (queue.length) {
    const comp = queue.shift();
    const compDir = path.join(distRoot, comp);
    if (!isDir(compDir)) continue;
    // 该组件目录内所有 json（含嵌套子组件 json，如 chat-markdown/xxx-node/xxx-node.json）
    const jsons = walkFiles(compDir).filter((f) => f.endsWith('.json'));
    for (const jf of jsons) {
      const json = readJsonSafe(jf);
      if (!json || typeof json !== 'object') continue;
      for (const ref of extractComponentRefs(json)) {
        const top = resolveTopLevelEntry(distRoot, jf, ref);
        if (!top || top.startsWith(`${EMBED_NPM_DIR}/`)) continue;
        if (ALWAYS_KEEP.has(top)) continue;
        if (!kept.has(top)) {
          kept.add(top);
          queue.push(top);
        }
      }
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// 步骤 4：内嵌依赖闭包（保留文件对 dist 根下其它顶层条目/内嵌 npm 的引用）
// ---------------------------------------------------------------------------
const IMPORT_RE = /(?:require\(|import\s+[^'"]*from\s+|import\s+|@import\s+|<wxs[^>]*\bsrc\s*=\s*)['"]([^'"]+)['"]/g;
const WXS_SRC_RE = /\bsrc\s*=\s*['"]([^'"]+)['"]/g;

function scanFileRefs(distRoot, file) {
  const text = readTextSafe(file);
  const tops = new Set();
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const top = resolveTopLevelEntry(distRoot, file, m[1]);
    if (top) tops.add(top);
  }
  // wxml 里的 <wxs src> 与 <import src>，单独扫一遍 src=
  if (file.endsWith('.wxml')) {
    WXS_SRC_RE.lastIndex = 0;
    while ((m = WXS_SRC_RE.exec(text)) !== null) {
      const top = resolveTopLevelEntry(distRoot, file, m[1]);
      if (top) tops.add(top);
    }
  }
  return tops;
}

/**
 * 计算 common/shared 下应保留的子目录：仅保留属于已保留组件的 shared/<name>。
 * 返回需要从扫描/保留中排除的 common/shared/<name> 绝对目录集合。
 */
function sharedSubdirsToDrop(distRoot, keptComponents) {
  const dropAbs = new Set();
  const sharedRoot = path.join(distRoot, 'common', 'shared');
  if (!isDir(sharedRoot)) return dropAbs;
  for (const e of fs.readdirSync(sharedRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (!keptComponents.has(e.name)) dropAbs.add(path.join(sharedRoot, e.name));
  }
  return dropAbs;
}

function expandEmbedClosure(distRoot, keptComponents, sharedDrop) {
  // 起始保留集 = 保留组件 + 始终保留目录
  const keptTop = new Set(keptComponents);
  for (const k of ALWAYS_KEEP) {
    if (isDir(path.join(distRoot, k))) keptTop.add(k);
  }

  // 待扫描文件：保留组件目录 + 始终保留目录（排除将被删除的 common/shared/<name>）
  const scanDirs = new Set();
  for (const k of keptTop) scanDirs.add(path.join(distRoot, k));

  const collectFiles = () => {
    const files = [];
    for (const d of scanDirs) {
      if (!isDir(d)) continue;
      for (const f of walkFiles(d)) {
        // 跳过将被删除的 common/shared/<name> 内文件
        let skip = false;
        for (const dd of sharedDrop) {
          if (f === dd || f.startsWith(dd + path.sep)) {
            skip = true;
            break;
          }
        }
        if (!skip) files.push(f);
      }
    }
    return files;
  };

  // 迭代到不动点：被引用的顶层条目（含 miniprogram_npm/<lib>）加入保留，并把其目录纳入下一轮扫描
  let changed = true;
  while (changed) {
    changed = false;
    const files = collectFiles();
    for (const f of files) {
      for (const top of scanFileRefs(distRoot, f)) {
        if (!keptTop.has(top)) {
          keptTop.add(top);
          changed = true;
        }
        const topDir = path.join(distRoot, top);
        if (isDir(topDir) && !scanDirs.has(topDir)) {
          scanDirs.add(topDir);
          changed = true;
        }
      }
    }
  }
  return keptTop;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.app || !args.dist) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const appDir = path.resolve(args.app);
  const distRoot = path.resolve(args.dist);

  if (!isDir(appDir)) {
    console.error(`[error] --app 不是有效目录：${appDir}`);
    process.exit(1);
  }
  if (!isDir(distRoot)) {
    console.error(`[error] --dist 不是有效目录：${distRoot}`);
    process.exit(1);
  }

  log(`app  = ${appDir}`);
  log(`dist = ${distRoot}`);
  log(`mode = ${args.dryRun ? 'DRY-RUN（不删文件）' : 'DELETE（真正删除）'}`);
  log('');

  // 1. 根集
  const roots = collectRootComponents(appDir, distRoot);
  // 2. 组件传递闭包
  const keptComponents = expandComponentClosure(distRoot, roots);
  // common/shared 子目录裁剪
  const sharedDrop = sharedSubdirsToDrop(distRoot, keptComponents);
  // 4. 内嵌依赖闭包（含 miniprogram_npm/<lib>）
  const keptTop = expandEmbedClosure(distRoot, keptComponents, sharedDrop);

  // dist 顶层条目
  const topEntries = fs.readdirSync(distRoot, { withFileTypes: true });

  const keepDirs = [];
  const deleteDirs = [];
  const keepRootFiles = [];
  const deleteRootFiles = [];

  for (const e of topEntries) {
    if (e.isDirectory()) {
      if (e.name === EMBED_NPM_DIR) {
        // 内嵌 npm 容器：逐个子库按 keptTop(miniprogram_npm/<lib>) 决定
        continue;
      }
      if (ALWAYS_KEEP.has(e.name) || keptTop.has(e.name)) keepDirs.push(e.name);
      else deleteDirs.push(e.name);
    } else if (e.isFile()) {
      if (REDUNDANT_FILE_NAMES.has(e.name)) deleteRootFiles.push(e.name);
      else if (ROOT_KEEP_FILE_EXT.has(path.extname(e.name)) || e.name.startsWith('index'))
        keepRootFiles.push(e.name);
      else keepRootFiles.push(e.name); // 默认保留根级工具文件
    }
  }

  // 内嵌 npm 子库
  const embedKeep = [];
  const embedDelete = [];
  const embedRoot = path.join(distRoot, EMBED_NPM_DIR);
  if (isDir(embedRoot)) {
    for (const e of fs.readdirSync(embedRoot, { withFileTypes: true })) {
      const tag = `${EMBED_NPM_DIR}/${e.name}`;
      if (keptTop.has(tag)) embedKeep.push(e.name);
      else embedDelete.push(e.name);
    }
  }

  // common/shared 待删子目录（相对展示）
  const sharedDropRel = [...sharedDrop].map((p) => path.relative(distRoot, p)).sort();

  // ----- 统计与输出 -----
  let deletedBytes = 0;
  let deletedFiles = 0;
  const tally = (p) => {
    deletedBytes += dirSizeBytes(p);
    if (isDir(p)) deletedFiles += walkFiles(p).length;
    else deletedFiles += 1;
  };

  log('=== 保留组件闭包 (' + keptComponents.size + ') ===');
  log([...keptComponents].sort().join(', '));
  log('');
  log('=== 始终保留共享目录 ===');
  log([...ALWAYS_KEEP].filter((k) => isDir(path.join(distRoot, k))).join(', '));
  log('');
  log('=== 保留内嵌 npm (' + embedKeep.length + ') ===');
  log(embedKeep.sort().join(', ') || '(无)');
  log('');
  log('=== 将删除组件目录 (' + deleteDirs.length + ') ===');
  log(deleteDirs.sort().join(', ') || '(无)');
  log('');
  log('=== 将删除内嵌 npm (' + embedDelete.length + ') ===');
  log(embedDelete.sort().join(', ') || '(无)');
  log('');
  log('=== 将删除 common/shared 子目录 (' + sharedDropRel.length + ') ===');
  log(sharedDropRel.join(', ') || '(无)');
  log('');
  log('=== 将删除根级冗余文件 ===');
  log(deleteRootFiles.join(', ') || '(无)');
  log('');

  // 收集待删绝对路径
  const targets = [];
  for (const d of deleteDirs) targets.push(path.join(distRoot, d));
  for (const e of embedDelete) targets.push(path.join(embedRoot, e));
  for (const s of sharedDrop) targets.push(s);
  for (const f of deleteRootFiles) targets.push(path.join(distRoot, f));

  for (const t of targets) tally(t);

  if (args.dryRun) {
    log(`[DRY-RUN] 将删除 ${deletedFiles} 个文件，约 ${kb(deletedBytes)} KB`);
    log(`[DRY-RUN] 保留 ${keepDirs.length} 个组件/共享目录 + ${embedKeep.length} 个内嵌库`);
    return;
  }

  for (const t of targets) {
    try {
      fs.rmSync(t, { recursive: true, force: true });
    } catch (err) {
      warn(`删除失败：${t} (${err.message})`);
    }
  }

  // 删除后统计 dist 剩余
  const remainFiles = walkFiles(distRoot).length;
  let remainBytes = 0;
  for (const f of walkFiles(distRoot)) {
    try {
      remainBytes += fs.statSync(f).size;
    } catch {
      /* ignore */
    }
  }
  log(`[DONE] 已删除 ${deletedFiles} 个文件，约 ${kb(deletedBytes)} KB`);
  log(`[DONE] dist 剩余 ${remainFiles} 个文件，约 ${kb(remainBytes)} KB`);
}

main();
