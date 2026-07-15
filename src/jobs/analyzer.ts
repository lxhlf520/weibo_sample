/**
 * 正式实验 - 评论数据采集与分析（微博适配版）
 * ============================================================================
 * 产出四张溯源表（4 张结果表均来源于此）：
 *   1. post_detail          - 帖子详情原始 API 响应（溯源）
 *   2. post_comment_meta    - 全部评论 API 原始响应（溯源）
 *   3. post_user_meta       - 评论用户信息 API 原始响应（溯源）
 *   4. comment_snapshots    - 结构化评论快照（支持构建评论树）
 *
 * 直跑调试：npx tsx src/jobs/analyzer.ts [experimentId]
 */

import { query, upsert, maybeOne } from '../lib/db';
import { getAllComments, getUserProfile } from '../lib/weibo-api';
import type { WeiboComment } from '../lib/weibo-api';
import {
  Account,
  fetchStatusRaw,
  sleep,
  ts,
  now,
  getActiveAccounts,
} from './shared';

interface PostRow {
  id: string;
  post_id: string;
  post_url: string;
  experiment_id: string;
}

interface ExperimentRun {
  id: string;
  status: string;
  t0_at?: string;
}

/** 提取评论的父评论 ID（微博用 rootidstr + reply_comment.id 判断） */
function getParentCommentId(c: WeiboComment): string | null {
  // 如果 reply_comment 存在，说明这是对某条评论的回复
  if (c.reply_comment?.id) return c.reply_comment.id;
  // 如果 rootidstr 存在且不等于自己的 id，说明属于某个评论线程
  if (c.rootidstr && c.rootidstr !== c.idstr) return c.rootidstr;
  // 否则是对帖子的直接评论
  return null;
}

/** 采集单个帖子的评论数据 */
async function collectPostComments(
  experimentId: string,
  post: PostRow,
  cookie: string,
): Promise<{ comments: number; users: number }> {
  // ── post_detail：保存帖子详情原始响应 ──
  const statusRaw = await fetchStatusRaw(cookie, post.post_id);
  if (statusRaw) {
    await upsert(
      'post_detail',
      { experiment_id: experimentId, post_id: post.id },
      {
        experiment_id: experimentId,
        post_id: post.id,
        weibo_mid: post.post_id,
        raw_response: JSON.stringify(statusRaw),
        captured_at: now(),
      },
    );
  }

  // ── 获取全部评论 ──
  const comments = await getAllComments(cookie, post.post_id, 10);

  // ── post_comment_meta：保存评论原始响应 ──
  if (comments.length > 0) {
    await upsert(
      'post_comment_meta',
      { experiment_id: experimentId, post_id: post.id },
      {
        experiment_id: experimentId,
        post_id: post.id,
        weibo_mid: post.post_id,
        post_url: post.post_url,
        raw_response: JSON.stringify(comments),
        captured_at: now(),
      },
    );
  }

  // ── comment_snapshots：结构化评论数据 ──
  const seenUsers = new Set<string>();

  for (const c of comments) {
    await upsert(
      'comment_snapshots',
      { experiment_id: experimentId, comment_id: c.idstr },
      {
        experiment_id: experimentId,
        post_id: post.id,
        weibo_mid: post.post_id,
        comment_id: c.idstr,
        parent_comment_id: getParentCommentId(c),
        author_uid: c.user?.idstr || String(c.user?.id || ''),
        author_name: c.user?.screen_name || '',
        content: c.text_raw || c.text || '',
        likes_count: c.like_counts || 0,
        comment_time: c.created_at || '',
        captured_at: now(),
      },
    );

    // 记录去重后的用户
    const uid = c.user?.idstr || String(c.user?.id || '');
    if (uid && !seenUsers.has(uid)) {
      seenUsers.add(uid);
      // 获取用户原始数据
      const profile = await getUserProfile(cookie, uid);
      if (profile) {
        await upsert(
          'post_user_meta',
          { experiment_id: experimentId, user_id: uid },
          {
            experiment_id: experimentId,
            user_id: uid,
            raw_response: JSON.stringify(profile),
            captured_at: now(),
          },
        );
      }
    }
  }

  return { comments: comments.length, users: seenUsers.size };
}

/** 对单个实验的所有帖子采集评论数据 */
async function collectExperiment(
  experimentId: string,
  accounts: Account[],
): Promise<{ posts: number; totalComments: number; totalUsers: number }> {
  const { rows: posts } = await query<PostRow>('posts', { experiment_id: experimentId });
  if (!posts.length) {
    console.log('  无帖子，跳过');
    return { posts: 0, totalComments: 0, totalUsers: 0 };
  }

  let totalComments = 0;
  let totalUsers = 0;

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const acc = accounts[i % accounts.length];
    try {
      const { comments, users } = await collectPostComments(experimentId, post, acc.cookie);
      totalComments += comments;
      totalUsers += users;
    } catch (e: any) {
      console.log(`    ⚠️ ${post.post_id} 评论采集失败: ${e.message}`);
    }
    await sleep(500 + Math.random() * 1000);
    if ((i + 1) % 20 === 0) {
      console.log(`    评论采集进度: ${i + 1}/${posts.length} (评论:${totalComments}, 用户:${totalUsers})`);
    }
  }

  return { posts: posts.length, totalComments, totalUsers };
}

export async function runAnalyzer(expIdArg?: string): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[评论数据采集] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const accounts = await getActiveAccounts();
  if (accounts.length < 2) {
    console.log(`❌ 可用账号不足（${accounts.length}），至少需要 2 个`);
    return;
  }
  console.log(`可用账号: ${accounts.length}`);

  let experiments: ExperimentRun[];

  if (expIdArg) {
    const exp = await maybeOne<ExperimentRun>('experiment_runs', { id: expIdArg });
    experiments = exp ? [exp] : [];
  } else {
    const { rows } = await query<ExperimentRun>('experiment_runs', {
      status: { $in: ['running', 'ready'] },
    });
    experiments = rows;
  }

  if (!experiments.length) {
    console.log('❌ 未找到 running/ready 状态的实验');
    return;
  }
  console.log(`目标实验: ${experiments.length} 个\n`);

  for (const exp of experiments) {
    const experimentId = String(exp.id);
    console.log(`[${experimentId}] 开始采集评论数据...`);
    const { posts, totalComments, totalUsers } = await collectExperiment(experimentId, accounts);
    console.log(`[${experimentId}] 完成: ${posts} 帖, ${totalComments} 条评论, ${totalUsers} 个用户\n`);
    await sleep(2000);
  }

  console.log(`✅ 评论数据采集完成`);
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/analyzer.ts')) {
  runAnalyzer(process.argv[2])
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('分析异常:', e);
      process.exit(1);
    });
}
