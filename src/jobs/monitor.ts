/**
 * 正式实验 - 每 30 分钟 tick 扫描所有 running 实验，按 t0_at 补采到点监控快照
 * ============================================================================
 * 多实验并行：每个实验有独立 t0_at；对每个 running 实验遍历 MONITOR_POINTS，
 * 若 now >= t0_at + offset 且该点不在 completed_points → 采集全部帖快照并标记完成。
 * 幂等：进程重启后按 completed_points 续采，不重复。
 * t72h 全部完成或超期 → status=completed。
 *
 * 直跑调试：npx tsx src/jobs/monitor.ts
 */

import { query, insert, updateOne } from '../lib/db';
import {
  Account,
  ExperimentRun,
  MONITOR_POINTS,
  POINT_OFFSET_HOURS,
  LIFECYCLE_HOURS,
  sleep,
  ts,
  now,
  fetchStatusRaw,
  getActiveAccounts,
} from './shared';

interface PostRow {
  id: string;
  post_id: string;
}

/** 采集指定实验在指定监控点的全部帖快照 */
async function capturePoint(experimentId: string, point: string, accounts: Account[]): Promise<number> {
  const { rows: posts } = await query<PostRow>('posts', { experiment_id: experimentId });
  let ok = 0;
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const md = await fetchStatusRaw(accounts[i % accounts.length].cookie, p.post_id);
    if (md && md.ok !== 0) {
      await insert('post_snapshots', {
        experiment_id: experimentId,
        post_id: String(p.id),
        weibo_mid: p.post_id,
        time_point: point,
        comments_count: md.comments_count || 0,
        reposts_count: md.reposts_count || 0,
        likes_count: md.attitudes_count || 0,
        captured_at: now(),
      });
      ok++;
    }
    await sleep(300 + Math.random() * 500);
  }
  return ok;
}

export async function runMonitorTick(): Promise<void> {
  console.log(`\n[监控 tick] ${ts()}`);

  const { rows: running } = await query<ExperimentRun>('experiment_runs', { status: 'running' });
  if (running.length === 0) {
    console.log('  无 running 实验');
    return;
  }
  console.log(`  running 实验: ${running.length} 个`);

  const accounts = await getActiveAccounts();
  if (accounts.length < 2) {
    console.log(`  ⚠️ 可用账号不足（${accounts.length}），跳过本次 tick`);
    return;
  }

  const nowMs = Date.now();

  for (const exp of running) {
    const experimentId = String(exp.id);
    if (!exp.t0_at) {
      console.log(`  [${experimentId}] 无 t0_at，跳过`);
      continue;
    }
    const t0Ms = new Date(exp.t0_at).getTime();
    const completed = new Set(exp.completed_points || []);
    const elapsedH = (nowMs - t0Ms) / 3600_000;

    // 找到所有已到点且未采集的监控点
    const due = MONITOR_POINTS.filter(
      (pt) => !completed.has(pt) && elapsedH >= POINT_OFFSET_HOURS[pt],
    );

    for (const pt of due) {
      console.log(`  [${experimentId}] 采集 ${pt}（已过 ${elapsedH.toFixed(1)}h）...`);
      const ok = await capturePoint(experimentId, pt, accounts);
      completed.add(pt);
      await updateOne('experiment_runs', { id: experimentId }, {
        completed_points: [...completed],
      });
      console.log(`  [${experimentId}] ${pt} 完成: ${ok} 帖`);
    }

    // 生命周期结束判定
    const allDone = MONITOR_POINTS.every((pt) => completed.has(pt));
    if (allDone || elapsedH >= LIFECYCLE_HOURS + 1) {
      await updateOne('experiment_runs', { id: experimentId }, { status: 'completed', completed_at: now() });
      console.log(`  [${experimentId}] ✅ 生命周期结束 → status=completed`);
    }
  }
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/monitor.ts')) {
  runMonitorTick()
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('监控异常:', e);
      process.exit(1);
    });
}
