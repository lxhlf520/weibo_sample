/**
 * 正式实验 - 常驻调度器（Node 原生定时，零外部依赖）
 * ============================================================================
 * 采集分批建池策略：
 *   16:00 / 18:00 / 20:00  runCollectBatch  每 2 小时采一批 2000 候选追加池，
 *                          跨批筛选累计；合格 ≥150 即停后续批次。
 *   20:00 批次采完后        finalizeExperiment 从池选 90 实验帖建实验
 *                          → runDailyComment 采 t0 基线 + 发评论
 *   每 30 分钟              runMonitorTick  扫描 running 实验补采到点快照
 *
 * 用每分钟一次的 setInterval 心跳判断整点触发（当天每个整点仅一次）。
 * 各任务 try/catch 隔离，串行不重叠。
 *
 * 启动：npx tsx src/jobs/scheduler.ts
 */

import { runCollectBatch, finalizeExperiment } from './collector';
import { runDailyComment } from './commenter';
import { runMonitorTick } from './monitor';
import { runCommentPermissionCheck } from './checker';
import { runAnalyzer } from './analyzer';
import { runRetryCollector } from './retry-collector';
import { ensureTemplates } from '../lib/seed-templates';
import { runStartupMigration } from '../lib/startup-migration';
import { closeDb } from '../lib/db';
import { COLLECT_HOURS, ts } from './shared';

const COMMENT_HOUR = 20; // 20:00 批次采完后 finalize + 评论
const CHECK_HOUR = 19;
const CHECK_MINUTE = 30; // 19:30 评论权限检测
const MONITOR_INTERVAL_MIN = 30; // 每 30 分钟监控一次
const ANALYZER_INTERVAL_MIN = 120; // 每 2 小时采集评论数据
const RETRY_HOURS = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]; // 奇数小时空闲重试

let busy = false; // 防止长任务重叠
const firedHours = new Map<string, Set<number>>(); // 日期 → 已触发的整点集合
let lastMonitorMinute = -1;
let checkedCommentPermToday = ''; // 当天已检测日期字符串
let lastAnalyzerMinute = -1;

async function guarded(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (busy) {
    console.log(`[调度] ${name} 跳过（有任务运行中）  [${ts()}]`);
    return;
  }
  busy = true;
  try {
    await fn();
  } catch (e) {
    console.error(`[调度] ${name} 异常  [${ts()}]:`, e);
  } finally {
    busy = false;
  }
}

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 判断某整点当天是否已触发过，未触发则记录并返回 true */
function claimHour(today: string, hour: number): boolean {
  let set = firedHours.get(today);
  if (!set) {
    set = new Set();
    firedHours.set(today, set);
    // 简单清理：只保留当天
    for (const k of firedHours.keys()) if (k !== today) firedHours.delete(k);
  }
  if (set.has(hour)) return false;
  set.add(hour);
  return true;
}

/** 20:00 批次：采集 → 选帖建实验 → 发评论（串行） */
async function runCommentPipeline(): Promise<void> {
  await runCollectBatch(); // 20 点这批补采（若已达标内部会跳过采集）
  const fin = await finalizeExperiment();
  if (fin) {
    await runDailyComment(fin.experimentId);
  }
}

async function heartbeat(): Promise<void> {
  const nowDate = new Date();
  const today = dateStr(nowDate);
  const hour = nowDate.getHours();
  const minute = nowDate.getMinutes();

  // 19:30 评论权限检测（每天一次）
  if (hour === CHECK_HOUR && minute === CHECK_MINUTE && today !== checkedCommentPermToday) {
    checkedCommentPermToday = today;
    await guarded('19:30 评论权限检测', runCommentPermissionCheck);
    return;
  }

  // 采集/评论整点触发（当天每个整点仅一次），在整点后 MONITOR_INTERVAL_MIN 分钟窗口内
  if (minute < MONITOR_INTERVAL_MIN && COLLECT_HOURS.includes(hour) && claimHour(today, hour)) {
    if (hour === COMMENT_HOUR) {
      await guarded('20点采集+选帖+评论', runCommentPipeline);
    } else {
      await guarded(`${hour}点采集批次`, runCollectBatch);
    }
    return;
  }

  // 每 30 分钟监控 tick
  const totalMin = Math.floor(nowDate.getTime() / 60000);
  if (totalMin % MONITOR_INTERVAL_MIN === 0 && totalMin !== lastMonitorMinute) {
    lastMonitorMinute = totalMin;
    await guarded('监控tick', runMonitorTick);
  }

  // 每 2 小时采集评论数据
  if (totalMin % ANALYZER_INTERVAL_MIN === 0 && totalMin !== lastAnalyzerMinute) {
    lastAnalyzerMinute = totalMin;
    await guarded('评论数据采集', runAnalyzer);
  }
  
  // 奇数小时空闲时重试采集失败（在整点后 30 分钟窗口内，不与其他任务重叠）
  if (minute >= 30 && minute < 60 && RETRY_HOURS.includes(hour) && claimHour(today, hour + 100)) {
    await guarded('空闲背压重试', () => runRetryCollector());
  }
}

function main(): void {
  console.log(`${'='.repeat(60)}`);
  console.log(`微博正式实验调度器启动  [${ts()}]`);
  console.log(`  采集批次: ${COLLECT_HOURS.join('/')}点 | ${CHECK_HOUR}:${CHECK_MINUTE} 权限检测 | ${COMMENT_HOUR}点批后选帖+评论 | 每${MONITOR_INTERVAL_MIN}min 监控`);
  console.log(`  背压重试: 奇数小时 30-59分 | 模板同步+数据迁移: 启动时自动`);
  console.log(`${'='.repeat(60)}`);

  // 启动任务（顺序执行）
  (async () => {
    // 启动时同步评论模板（先跑，不依赖 posts）
    await guarded('模板同步', async () => {
      const { created, existing } = await ensureTemplates();
      console.log(`[模板同步] 新增 ${created} 条, 已有 ${existing} 条`);
    });

    // 启动时：数据迁移（PREFIX 适配 + post_group 回填）
    await guarded('启动数据迁移', async () => {
      const { postsMigrated, postGroupBackfilled, skipped } = await runStartupMigration();
      if (!skipped) {
        console.log(`[启动迁移] 帖子迁移 ${postsMigrated} 条, post_group 回填 ${postGroupBackfilled} 条`);
      }
    });

    // 启动即跑一次监控（补采可能遗漏的点）
    await guarded('启动监控', runMonitorTick);
  })();

  // 每分钟心跳
  setInterval(() => {
    heartbeat().catch((e) => console.error('[调度] 心跳异常:', e));
  }, 60_000);
}

async function shutdown(): Promise<void> {
  console.log(`\n[调度] 收到退出信号，关闭连接...  [${ts()}]`);
  try {
    await closeDb();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
