/**
 * 正式实验 - 分批增量建池 + 选帖建实验
 * ============================================================================
 * 策略（16/18/20 每 2 小时一批）：
 *   runCollectBatch()   单批采集 CANDIDATE_BATCH 条候选 → 筛选 → 按作者去重
 *                       upsert 到 candidate_pool（跨批累计）；合格 ≥ TARGET_QUALIFIED
 *                       则标记 pool_full，后续批次跳过采集。红线约束绝不放宽。
 *   finalizeExperiment() 从 candidate_pool 选 EXPERIMENT_POSTS 实验帖（三等分+模板）
 *                       + 其余作备选(is_spare)，写 posts / intervention_logs，
 *                       实验 status → ready。池不足 90 则缩减为最大 3 倍数并告警。
 *
 * 直跑调试：
 *   npx tsx src/jobs/collector.ts batch      # 跑一批采集
 *   npx tsx src/jobs/collector.ts finalize   # 选帖建实验
 */

import { insert, query, maybeOne, updateOne, upsert, count } from '../lib/db';
import { randomizeAndGroup, assignTemplates } from '../lib/experiment-engine';
import {
  ScreeningPost,
  CANDIDATE_BATCH,
  MAX_BATCHES,
  TARGET_QUALIFIED,
  EXPERIMENT_POSTS,
  MAX_PAGES_PER_KEYWORD,
  SEARCH_KEYWORDS,
  sleep,
  ts,
  now,
  scrapeRealtimeMids,
  fetchStatusRaw,
  screenStatus,
  getActiveAccounts,
} from './shared';

const POOL = 'candidate_pool'; // 跨批累计的合格帖候选池集合

/** 找/建当天处于采集期的实验；若当天已 finalize（非 collecting）返回 null 表示无需采集 */
async function getOrCreateCollectingExp(): Promise<{ id: string; pool_full?: boolean; batch_count?: number; seen_mids?: string[] } | null> {
  const today = new Date().toISOString().split('T')[0];
  const existing = await maybeOne<{ id: string; status: string; pool_full?: boolean; batch_count?: number; seen_mids?: string[] }>(
    'experiment_runs',
    { experiment_date: today },
  );
  if (existing) {
    if (existing.status !== 'collecting') {
      console.log(`  当天实验已处于 ${existing.status} 状态，跳过采集`);
      return null;
    }
    return existing;
  }
  const created = await insert<{ id: string }>('experiment_runs', {
    user_id: 'admin',
    date: today,
    experiment_date: today,
    status: 'collecting',
    batch_count: 0,
    pool_full: false,
    seen_mids: [],
    completed_points: [],
    created_at: now(),
  });
  return created ? { id: String(created.id), batch_count: 0, seen_mids: [] } : null;
}

/** 单批采集：抓候选 → 筛选 → 按作者去重 upsert 到候选池 */
export async function runCollectBatch(): Promise<{ experimentId: string; qualified: number; poolFull: boolean } | null> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[采集批次] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const accounts = await getActiveAccounts();
  if (accounts.length < 2) {
    console.log(`❌ 可用账号不足（${accounts.length}），至少需要 2 个`);
    return null;
  }
  console.log(`可用账号 (${accounts.length}): ${accounts.map((a) => a.nickname).join(', ')}`);

  const exp = await getOrCreateCollectingExp();
  if (!exp) return null;
  const experimentId = exp.id;

  // 已达标或批次用尽 → 跳过采集
  let qualified = await count(POOL, { experiment_id: experimentId });
  if (exp.pool_full || qualified >= TARGET_QUALIFIED) {
    console.log(`  候选池已达标（${qualified}/${TARGET_QUALIFIED}），跳过本批采集`);
    await updateOne('experiment_runs', { id: experimentId }, { pool_full: true });
    return { experimentId, qualified, poolFull: true };
  }
  if ((exp.batch_count || 0) >= MAX_BATCHES) {
    console.log(`  已达最大批次 ${MAX_BATCHES}，跳过采集`);
    return { experimentId, qualified, poolFull: false };
  }
  console.log(`  当前池: ${qualified}/${TARGET_QUALIFIED}  批次: ${(exp.batch_count || 0) + 1}/${MAX_BATCHES}`);

  // ── 抓取本批候选 mid（排除历史已见）──
  const seen = new Set<string>(exp.seen_mids || []);
  const batchMids = new Set<string>();
  outer: for (let page = 1; page <= MAX_PAGES_PER_KEYWORD; page++) {
    for (const kw of SEARCH_KEYWORDS) {
      const ci = batchMids.size % accounts.length;
      try {
        const mids = await scrapeRealtimeMids(accounts[ci].cookie, kw, page);
        for (const m of mids) if (!seen.has(m)) batchMids.add(m);
      } catch {
        /* 单次失败跳过 */
      }
      await sleep(500 + Math.random() * 700);
      if (batchMids.size >= CANDIDATE_BATCH) break outer;
    }
    console.log(`  第${page}页轮询完成，本批新增 ${batchMids.size} 个 mid`);
  }
  const mids = [...batchMids];
  console.log(`\n本批候选（去重历史后）: ${mids.length} 个 mid`);

  // ── 逐条筛选 → 按作者去重 upsert 到池 ──
  const cutoff = Date.now() - 12 * 3600 * 1000;
  let added = 0;
  for (let i = 0; i < mids.length; i++) {
    const mid = mids[i];
    seen.add(mid);
    const md = await fetchStatusRaw(accounts[i % accounts.length].cookie, mid);
    const sp = screenStatus(md, mid, cutoff);
    if (sp) {
      // 作者级去重：同一作者只保留一条
      const before = await count(POOL, { experiment_id: experimentId, author_uid: sp.authorUid });
      await upsert(POOL, { experiment_id: experimentId, author_uid: sp.authorUid }, {
        experiment_id: experimentId,
        mid: sp.postId,
        post_url: sp.postUrl,
        content: sp.content,
        author_uid: sp.authorUid,
        author_name: sp.authorName,
        followers: sp.followers,
        comments_count: sp.commentsCount,
        reposts_count: sp.repostsCount,
        likes_count: sp.likesCount,
        published_at: sp.publishedAt,
      });
      if (before === 0) added++;
    }
    await sleep(300 + Math.random() * 600);
    qualified = await count(POOL, { experiment_id: experimentId });
    if ((i + 1) % 50 === 0) console.log(`  进度: ${i + 1}/${mids.length}（池累计 ${qualified}）`);
    if (qualified >= TARGET_QUALIFIED) {
      console.log(`  合格已达标: ${qualified}（本批扫描 ${i + 1} 条）`);
      break;
    }
  }

  qualified = await count(POOL, { experiment_id: experimentId });
  const poolFull = qualified >= TARGET_QUALIFIED;
  await updateOne('experiment_runs', { id: experimentId }, {
    batch_count: (exp.batch_count || 0) + 1,
    pool_full: poolFull,
    seen_mids: [...seen],
  });

  console.log(`\n✅ 本批完成: 新增合格 ${added} 篇，池累计 ${qualified}/${TARGET_QUALIFIED}${poolFull ? '（已达标）' : ''}`);
  return { experimentId, qualified, poolFull };
}

/** 选帖建实验：从候选池选实验帖 + 备选，写 posts / intervention_logs，status → ready */
export async function finalizeExperiment(): Promise<{ experimentId: string } | null> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[选帖建实验] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const today = new Date().toISOString().split('T')[0];
  const exp = await maybeOne<{ id: string; status: string }>('experiment_runs', { experiment_date: today });
  if (!exp) {
    console.log('❌ 未找到当天实验');
    return null;
  }
  const experimentId = String(exp.id);
  if (exp.status !== 'collecting') {
    console.log(`  当天实验已处于 ${exp.status} 状态，无需重复 finalize`);
    return { experimentId };
  }

  const { rows: poolRows } = await query<{
    id: string; mid: string; post_url: string; content: string;
    author_uid: string; author_name: string; followers: number;
    comments_count: number; reposts_count: number; likes_count: number; published_at: string;
  }>(POOL, { experiment_id: experimentId });
  // 池中为下划线字段，映射回 ScreeningPost（驼峰）供后续分组/写入使用
  const pool: ScreeningPost[] = poolRows.map((r) => ({
    postId: r.mid,
    postUrl: r.post_url,
    content: r.content,
    authorUid: r.author_uid,
    authorName: r.author_name,
    followers: r.followers,
    commentsCount: r.comments_count,
    repostsCount: r.reposts_count,
    likesCount: r.likes_count,
    publishedAt: r.published_at,
  }));
  console.log(`候选池合格帖: ${pool.length} 篇`);

  // ── 实验帖数：池 ≥90 取 90；否则缩减为最大 3 的倍数并告警 ──
  let expCount = EXPERIMENT_POSTS;
  if (pool.length < EXPERIMENT_POSTS) {
    expCount = Math.floor(pool.length / 3) * 3;
    console.log(`⚠️ 告警：候选池不足 ${EXPERIMENT_POSTS} 篇，缩减实验帖为 ${expCount}（三等分）`);
    if (expCount < 3) {
      await updateOne('experiment_runs', { id: experimentId }, { status: 'failed', fail_reason: `候选池仅 ${pool.length} 篇` });
      console.log(`❌ 候选池过少（${pool.length}），实验标记 failed`);
      return null;
    }
  }

  // ── 选帖：前 expCount 实验帖，其余（至多 TARGET_QUALIFIED）作备选 ──
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const total = Math.min(shuffled.length, TARGET_QUALIFIED);
  const finalPosts = shuffled.slice(0, total);
  const experimentPosts = finalPosts.slice(0, expCount);
  const sparePosts = finalPosts.slice(expCount);
  console.log(`实验帖 ${experimentPosts.length} 篇 + 备选 ${sparePosts.length} 篇`);

  // ── 分组 + 模板 ──
  const { grouped, config } = randomizeAndGroup(experimentPosts as any, expCount);
  const withTemplates = await assignTemplates(grouped as any);

  // ── 写实验帖 + intervention_logs ──
  for (const item of withTemplates) {
    const p = (item as any).post as ScreeningPost;
    const post = await insert<{ id: string }>('posts', {
      user_id: 'admin',
      experiment_id: experimentId,
      mid: p.postId,
      post_url: p.postUrl,
      content: p.content,
      author_uid: p.authorUid,
      author_name: p.authorName,
      followers: p.followers,
      comments_count: p.commentsCount,
      reposts_count: p.repostsCount,
      likes_count: p.likesCount,
      post_group: item.group,
      is_spare: false,
      published_at: p.publishedAt,
    });
    if (post && item.group !== 'control') {
      await insert('intervention_logs', {
        experiment_id: experimentId,
        post_id: String(post.id),
        post_url: p.postUrl,
        post_group: item.group,
        comment_template: (item as any).templateId ? String((item as any).templateId) : null,
        comment_content: item.commentContent,
        status: 'pending',
      });
    }
  }

  // ── 写备选池 ──
  for (const p of sparePosts) {
    await insert('posts', {
      user_id: 'admin',
      experiment_id: experimentId,
      mid: p.postId,
      post_url: p.postUrl,
      content: p.content,
      author_uid: p.authorUid,
      author_name: p.authorName,
      followers: p.followers,
      comments_count: p.commentsCount,
      reposts_count: p.repostsCount,
      likes_count: p.likesCount,
      post_group: null,
      is_spare: true,
      published_at: p.publishedAt,
    });
  }

  await updateOne('experiment_runs', { id: experimentId }, {
    status: 'ready',
    total_posts: finalPosts.length,
    control_count: config.controlCount,
    low_count: config.lowCount,
    high_count: config.highCount,
  });

  console.log(`\n✅ 实验就绪`);
  console.log(`   experimentId: ${experimentId}`);
  console.log(`   control: ${config.controlCount} | low: ${config.lowCount} | high: ${config.highCount}`);
  console.log(`   待发评论: ${withTemplates.filter((i) => i.group !== 'control').length} 条`);
  console.log(`   备选池: ${sparePosts.length} 篇`);
  return { experimentId };
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/collector.ts')) {
  const mode = process.argv[2] || 'batch';
  const run = mode === 'finalize' ? finalizeExperiment : runCollectBatch;
  run()
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('采集异常:', e);
      process.exit(1);
    });
}
