#!/usr/bin/env node
/**
 * Trae CN 任务清理工具 (CDP + 内部 API 直调版, 带实时日志)
 *
 * 原理: 通过 Chrome 调试协议连进 Trae 页面, 从 React 组件上拿到内部
 *       sessionAdapter, 直接调用其 deleteSession API 删除任务 —— 和
 *       UI 点击"删除任务"完全等效, 但无需模拟任何点击。
 *
 * 用法:
 *   node trae-task-cleaner.mjs inspect                          # 列出 CDP 页面目标
 *   node trae-task-cleaner.mjs eval [--title X] "<js代码>"       # 在页面里执行任意 JS (调试用)
 *   node trae-task-cleaner.mjs clean [--title X] [--keep 20] \
 *        [--batch M] [--dry-run]                                # 清理单个窗口的任务
 *   node trae-task-cleaner.mjs auto [--keep 20] [--dry-run]     # 按 trae-projects.txt 清理所有已打开的项目
 *
 * auto 模式: 读取脚本同目录的 trae-projects.txt (一行一个项目名),
 *           自动匹配当前打开的 Trae 窗口, 只处理已打开的项目。
 *
 * 前提: Trae CN 需以调试端口启动, 且目标窗口的任务面板处于打开状态:
 *   "<Trae 安装目录>\Trae CN.exe" --remote-debugging-port=9222
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_LIST_FILE = path.join(__dirname, 'trae-projects.txt');
const CDP_PORT = process.env.CDP_PORT || 9222;
const CDP_HOST = `http://127.0.0.1:${CDP_PORT}`;

async function listTargets() {
  const res = await fetch(`${CDP_HOST}/json/list`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || 'unknown')));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      };
    });
  }
  send(method, params = {}, timeoutMs = 90000) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时 (${timeoutMs / 1000}s) 无响应`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** 在页面上下文执行 JS,返回 {result, exceptionDetails} */
  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    return this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
    });
  }
  close() { if (this.ws) this.ws.close(); }
}

async function pickChatTarget(titleFilter) {
  const targets = await listTargets();
  const pages = targets.filter(t => t.type === 'page');
  if (titleFilter) {
    const hit = pages.filter(t => t.title.includes(titleFilter));
    if (hit.length) return { targets, pages, candidates: [hit[0]] };
    console.error(`没有标题含 "${titleFilter}" 的页面,现有:`);
    for (const t of pages) console.error('  - ' + t.title);
    process.exit(2);
  }
  // 在包含任务面板文本的 workbench 页面里找 (Trae 的 AI 面板直接渲染在 workbench DOM)
  let best = null;
  for (const t of pages) {
    const s = new CdpSession(t.webSocketDebuggerUrl);
    try {
      await s.connect();
      const r = await s.evaluate(`(() => {
        const txt = document.body?.innerText || '';
        return JSON.stringify({
          title: document.title,
          hasTaskPanel: /任务/.test(txt) && /(任务中断|任务完成|进行中|排队中)/.test(txt),
        });
      })()`);
      s.close();
      if (!r.exceptionDetails) {
        const info = JSON.parse(r.result.value);
        if (info.hasTaskPanel) { best = t; break; }
      }
    } catch (e) { s.close(); }
  }
  const candidates = best ? [best] : pages.filter(t =>
    /chat|ai[-_]?agent|solo/i.test(t.title + ' ' + t.url));
  return { targets, pages, candidates };
}

async function withChatSession(fn, titleFilter) {
  const { targets, pages, candidates } = await pickChatTarget(titleFilter);
  if (!candidates.length) {
    console.error('未找到可用页面目标。全部目标:');
    for (const t of targets) console.error(` [${t.type}] ${t.title} :: ${t.url}`);
    process.exit(2);
  }
  let lastErr = null;
  for (const t of candidates) {
    const s = new CdpSession(t.webSocketDebuggerUrl);
    try {
      await s.connect();
      const r = await s.evaluate('typeof window !== "undefined"');
      if (!r.exceptionDetails) {
        return { session: s, target: t, all: targets };
      }
    } catch (e) { lastErr = e; }
    s.close();
  }
  throw lastErr || new Error('无法连接任何目标');
}

async function cmdInspect() {
  const { targets } = await pickChatTarget();
  console.log(`共 ${targets.length} 个目标:`);
  for (const t of targets) {
    console.log(` [${t.type}] ${t.title.slice(0, 60)} :: ${t.url.slice(0, 100)}`);
  }
  console.log('\n--- 在各页面目标中探测聊天面板 ---');
  const pages = targets.filter(t => t.type === 'page');
  for (const t of pages) {
    const s = new CdpSession(t.webSocketDebuggerUrl);
    try {
      await s.connect();
      const probe = await s.evaluate(`(() => {
        const txt = (document.body?.innerText || '').slice(0, 400);
        return JSON.stringify({
          title: document.title,
          url: location.href.slice(0, 120),
          hasChatText: /任务|会话|历史|聊天|Chat/.test(txt),
          textHead: txt.replace(/\\n+/g, ' | ').slice(0, 200),
        });
      })()`);
      if (!probe.exceptionDetails) {
        const info = JSON.parse(probe.result.value);
        console.log(`\n* ${t.title.slice(0, 50)} :: ${info.url}`);
        console.log(`  含聊天文本: ${info.hasChatText}`);
        console.log(`  文本头: ${info.textHead}`);
      }
    } catch (e) {
      console.log(`\n* ${t.title.slice(0, 50)} -> 连接失败: ${e.message}`);
    } finally { s.close(); }
  }
}

async function cmdEval(expr, titleFilter) {
  const { session, target } = await withChatSession(null, titleFilter);
  console.log(`目标: ${target.title}`);
  try {
    const r = await session.evaluate(expr);
    if (r.exceptionDetails) {
      console.error('执行异常:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    } else {
      const v = r.result.value;
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    }
  } finally { session.close(); }
}

/** 第一步: 找到 sessionAdapter 挂到 window, 拉全任务列表后返回 JSON */
const SETUP_JS = `
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function findAdapter() {
    const anchors = ['[data-session-id]', '[class*=task-items-list]', '[class*=task-title]'];
    for (const sel of anchors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'));
      if (!fk) continue;
      let fiber = el[fk];
      for (let i = 0; i < 100 && fiber; i++, fiber = fiber.return) {
        if (fiber.memoizedProps && fiber.memoizedProps.sessionAdapter) {
          return fiber.memoizedProps.sessionAdapter;
        }
      }
    }
    return null;
  }
  const adapter = findAdapter() || window.__traeCleanerAdapter;
  if (!adapter) return JSON.stringify({ error: '未找到 sessionAdapter (请确认该窗口的 AI 任务面板已打开)' });
  window.__traeCleanerAdapter = adapter;

  let pages = 0;
  for (let i = 0; i < 60 && adapter.sessionsHasMore; i++) {
    try { await Promise.race([adapter.loadMoreSessions(), new Promise(r => setTimeout(r, 8000))]); } catch (e) { break; }
    await sleep(300);
    pages++;
  }
  const ts = s => Math.max(s.updateAt || 0, s.updatedAt || 0, s.createdAt || 0);
  const tasks = [...adapter.sessions].sort((a, b) => ts(b) - ts(a)); // 新 -> 旧
  return JSON.stringify({ ok: true, pages, total: adapter.sessions.length, tasks: tasks.map(t => ({
    id: t.sessionId, name: t.title || t.name || t.sessionId,
    status: t.status || '?', pinned: !!t.isPinned, ts: ts(t),
  })) });
})()
`;

/** 第二步: 删除单个任务。以 RPC 结果为准: resolved 或 "not found"(后端已删,界面残留幽灵) 都算成功 */
const DELETE_ONE_JS = `
(async () => {
  const a = window.__traeCleanerAdapter;
  if (!a) return JSON.stringify({ ok: false, err: 'adapter lost' });
  const id = TARGET_ID;
  const t0 = Date.now();
  let r;
  try {
    r = await Promise.race([
      a.deleteSession(id).then(() => 'ok', e => 'reject: ' + (e && (e.message || String(e)))),
      new Promise(res => setTimeout(() => res('timeout: 8s 无响应'), 8000)),
    ]);
  } catch (e) { r = 'outer: ' + e.message; }
  const ok = r === 'ok' || /not found/i.test(r);
  if (ok) await new Promise(rr => setTimeout(rr, 300));
  return JSON.stringify({ ok, detail: r, ms: Date.now() - t0 });
})()
`;

async function evalJson(session, expr) {
  const r = await session.evaluate(expr, { awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return JSON.parse(r.result.value);
}

const TERMINAL = /^(Completed|Interrupted|Failed|Error|Cancelled|Stopped)$/i;

/** 对一个已连接的窗口执行完整清理流程, 返回汇总(不 process.exit, 供 auto 模式继续处理其他窗口) */
async function processWindow(session, target, keepCount, dryRun, maxDelete) {
  console.log(`[2/3] 定位内部 API (sessionAdapter) 并拉取任务列表 ...`);
  let setup;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      setup = await evalJson(session, SETUP_JS);
    } catch (e) {
      setup = { error: e.message };
    }
    if (!setup.error) break;
    // 面板可能还在渲染, 等 4 秒重试一次
    if (attempt === 1) {
      console.log(`     ${setup.error} , 4 秒后重试 ...`);
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  if (setup.error) return { error: setup.error };

  const tasks = setup.tasks; // 新 -> 旧
  console.log(`     完成: 共 ${setup.total} 个任务${setup.pages ? ` (加载了 ${setup.pages} 页)` : ''}`);

  // 保护集: 置顶 + 非终态(运行中/排队等) + 最新 keep 个
  const protectedIds = new Set();
  for (const t of tasks) {
    if (t.pinned || !TERMINAL.test(t.status)) protectedIds.add(t.id);
  }
  const pinnedCount = tasks.filter(t => t.pinned).length;
  const activeCount = [...protectedIds].length - pinnedCount;
  for (const t of tasks.slice(0, keepCount)) protectedIds.add(t.id);
  const toDelete = tasks.filter(t => !protectedIds.has(t.id)).reverse(); // 旧 -> 新, 从最旧开始删

  console.log(`     受保护: 置顶 ${pinnedCount} 个, 运行/排队中 ${Math.max(0, activeCount)} 个, 最新 ${keepCount} 个`);
  console.log(`     待删除: ${toDelete.length} 个`);
  if (!toDelete.length) { console.log('     没有需要删除的任务。'); return { total: tasks.length, deleted: 0, failed: 0, wouldDelete: dryRun ? 0 : undefined }; }

  if (dryRun) {
    console.log(`\n[预览] 将删除以下 ${toDelete.length} 个任务 (从最旧开始, 最多显示 10 条):`);
    toDelete.slice(0, 10).forEach((t, i) => console.log(`  ${String(i + 1).padStart(3)}. ${t.name} [${t.status}]`));
    if (toDelete.length > 10) console.log(`  ... 等共 ${toDelete.length} 个`);
    return { total: tasks.length, wouldDelete: toDelete.length };
  }

  console.log(`\n[3/3] 开始删除 ${Math.min(toDelete.length, maxDelete)} 个任务:`);
  let ok = 0, fail = 0;
  const failures = [];
  const t0 = Date.now();
  for (let i = 0; i < toDelete.length && ok + fail < maxDelete; i++) {
    const t = toDelete[i];
    const name = t.name.length > 40 ? t.name.slice(0, 40) + '…' : t.name;
    process.stdout.write(`  [${String(i + 1).padStart(3)}/${toDelete.length}] ${name} ... `);
    let res = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        res = await evalJson(session, DELETE_ONE_JS.replace('TARGET_ID', JSON.stringify(t.id)));
      } catch (e) {
        res = { ok: false, err: e.message };
      }
      if (res.ok) break;
      if (attempt === 1) process.stdout.write('重试 ... ');
    }
    if (res.ok) {
      ok++;
      console.log(res.detail === 'ok' ? `完成 (${(res.ms / 1000).toFixed(1)}s)` : '完成 (后端已删过,界面残留)');
    } else {
      fail++;
      failures.push(`${t.name}: ${res.err || res.detail}`);
      console.log(`失败! (${res.err || res.detail})`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n完成: 删除 ${ok} 个, 失败 ${fail} 个, 耗时 ${elapsed}s`);
  if (failures.length) {
    console.log('失败明细:');
    failures.forEach(e => console.log('  ! ' + e));
  }
  if (ok + fail < toDelete.length) {
    console.log(`本批到达上限 (${maxDelete}), 还有 ${toDelete.length - ok - fail} 个待删, 重新运行本命令继续。`);
  }
  return { total: tasks.length, deleted: ok, failed: fail };
}

async function cmdClean(titleFilter, keepCount, dryRun, maxDelete) {
  console.log(`[1/3] 连接 Trae 调试端口 ${CDP_PORT} ...`);
  const { session, target } = await withChatSession(null, titleFilter);
  console.log(`     目标窗口: ${target.title}`);
  console.log(`模式: ${dryRun ? 'DRY-RUN 预览 (不会真的删除)' : '实际删除'}, 保留最新 ${keepCount} 个任务, 本批最多删 ${maxDelete} 个`);
  try {
    const r = await processWindow(session, target, keepCount, dryRun, maxDelete);
    if (r.error) { console.error('错误:', r.error); process.exit(1); }
  } finally { session.close(); }
}

/** 读取项目清单文件; 不存在则用示例生成模板 */
function readProjectList() {
  if (!fs.existsSync(PROJECT_LIST_FILE)) {
    const sample = [
      '# Trae CN 任务自动清理的项目清单',
      '# 一行一个项目名 (要和 Trae 窗口标题里的项目名完全一致)',
      '# # 开头的行是注释; 没打开窗口的项目会自动跳过',
      '',
      'my-web-app',
      'my-backend-api',
      '',
    ].join('\r\n');
    fs.writeFileSync(PROJECT_LIST_FILE, sample, 'utf8');
    console.log(`已生成项目清单模板: ${PROJECT_LIST_FILE}`);
  }
  return fs.readFileSync(PROJECT_LIST_FILE, 'utf8')
    .split(/\r?\n/)
    .map(l => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

/** 从窗口标题提取项目名: "<文件> - <项目> - TraeCode CN" */
function extractProject(title) {
  let m = title.match(/^(.*) - (.+?) - TraeCode CN\s*$/); // 两段式: 文件 - 项目 - TraeCode
  if (m) return m[2].trim();
  m = title.match(/^(.+?) - TraeCode CN\s*$/); // 一段式: 项目 - TraeCode
  if (m) return m[1].trim();
  return null;
}

async function cmdAuto(keepCount, dryRun, maxDelete) {
  const projects = readProjectList();
  if (!projects.length) {
    console.error(`项目清单为空, 请编辑: ${PROJECT_LIST_FILE}`);
    process.exit(2);
  }
  console.log(`[1/3] 连接 Trae 调试端口 ${CDP_PORT} ...`);
  let targets;
  try {
    targets = await listTargets();
  } catch (e) {
    console.error(`无法连接调试端口: ${e.message}`);
    console.error('请以调试模式启动 Trae 后重试:');
    console.error('  "<Trae 安装目录>\\Trae CN.exe" --remote-debugging-port=9222');
    process.exit(2);
  }
  const pages = targets.filter(t => t.type === 'page');
  const projectSet = new Set(projects);
  const matched = [];
  const openProjects = new Set();
  for (const t of pages) {
    const proj = extractProject(t.title);
    if (proj && projectSet.has(proj) && !openProjects.has(proj)) {
      openProjects.add(proj);
      matched.push({ target: t, project: proj });
    }
  }
  const notOpen = projects.filter(p => !openProjects.has(p));

  console.log(`配置了 ${projects.length} 个项目, 其中 ${matched.length} 个已打开:`);
  matched.forEach(m => console.log(`  + ${m.project}`));
  if (notOpen.length) console.log(`  - 未打开, 跳过: ${notOpen.join(', ')}`);
  if (!matched.length) { console.log('\n没有已打开的配置项目, 结束。'); return; }

  console.log(`\n模式: ${dryRun ? 'DRY-RUN 预览 (不会真的删除)' : '实际删除'}, 每个项目保留最新 ${keepCount} 个任务\n`);

  const summary = [];
  for (const m of matched) {
    console.log(`\n========== 项目: ${m.project} ==========`);
    console.log(`窗口: ${m.target.title.slice(0, 70)}`);
    const s = new CdpSession(m.target.webSocketDebuggerUrl);
    try {
      await s.connect();
      const r = await processWindow(s, m.target, keepCount, dryRun, maxDelete);
      summary.push({ project: m.project, ...r });
    } catch (e) {
      console.error(`连接失败: ${e.message}`);
      summary.push({ project: m.project, error: '连接失败: ' + e.message });
    } finally { s.close(); }
  }

  console.log('\n==================== 汇总 ====================');
  for (const s of summary) {
    let line;
    if (s.error) line = `× ${s.project}: ${s.error}`;
    else if (s.wouldDelete !== undefined) line = `- ${s.project}: 共 ${s.total} 个, 预删 ${s.wouldDelete} 个 (dry-run)`;
    else line = `- ${s.project}: 共 ${s.total} 个, 删除 ${s.deleted} 个, 失败 ${s.failed} 个`;
    console.log(line);
  }
  console.log('===============================================');
  if (!dryRun) console.log('\n提示: 若界面上有删不掉的残留条目, 重启一次 Trae 即可 (只是显示残留, 后端已删)。');
}

const args = process.argv.slice(2);
const cmd = args[0];
function optValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? { i, v: args[i + 1] } : { i: -1, v: undefined };
}
const { i: titleIdx, v: titleFilter } = optValue('--title');
const { i: keepIdx, v: keepArg } = optValue('--keep');
const keepCount = keepIdx >= 0 ? parseInt(keepArg, 10) : 20;
const { i: batchIdx, v: batchArg } = optValue('--batch');
const maxDelete = batchIdx >= 0 ? parseInt(batchArg, 10) : 1000000;
const dryRun = args.includes('--dry-run');
const skipIdx = new Set();
for (const idx of [titleIdx, keepIdx, batchIdx]) {
  if (idx >= 0) { skipIdx.add(idx); skipIdx.add(idx + 1); }
}
const restArgs = args.filter((a, i) => !skipIdx.has(i) && a !== '--dry-run');

if (cmd === 'inspect') {
  cmdInspect().catch(e => { console.error('错误:', e.message); process.exit(1); });
} else if (cmd === 'eval') {
  if (!restArgs[1]) { console.error('用法: eval [--title 标题] "<js>"'); process.exit(1); }
  cmdEval(restArgs[1], titleFilter).catch(e => { console.error('错误:', e.message); process.exit(1); });
} else if (cmd === 'clean') {
  cmdClean(titleFilter, keepCount, dryRun, maxDelete).catch(e => { console.error('错误:', e.message); process.exit(1); });
} else if (cmd === 'auto') {
  cmdAuto(keepCount, dryRun, maxDelete).catch(e => { console.error('错误:', e.message); process.exit(1); });
} else {
  console.log('可用命令:\n  inspect                                   列出 CDP 目标\n  eval [--title X] "<js>"                   在任务面板页面执行 JS\n  clean [--title X] [--keep N] [--batch M] [--dry-run]   清理单个窗口的任务\n  auto [--keep N] [--dry-run]               按 trae-projects.txt 清理所有已打开的项目');
}