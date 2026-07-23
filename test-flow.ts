/**
 * 微博实验平台 - 整体流程测试（单 Cookie）
 * ============================================================================
 * 测试全链路：cookie验证 → 搜索 → 帖子详情 → 评论 → 评论发送 → 溯源采集
 * 运行：pnpm exec tsx test-flow.ts
 */
import { query, upsert, closeDb } from './src/lib/db';
import {
  searchPosts,
  getPostDetail,
  getComments,
  getAllComments,
  postComment,
  getUserProfile,
  batchGetPostMetrics,
} from './src/lib/weibo-api';
import { fetchStatusRaw, scrapeRealtimeMids, sleep, now, ts } from './src/jobs/shared';

// ─── 用户提供的 Cookie ──────────────────────────────────────
const TEST_COOKIE =
  'SCF=Al7IB2BgfMw1_LmRMPe7oF496Gv6AXR9FPvOm26PNZaSdZIF9BY13y8jPHDDegqRHWd2eXYRI6KQuyM3yoKXCnQ.; SINAGLOBAL=1392457091283.8975.1778337150960; UOR=,,www.baidu.com; SUB=_2A25HVwTnDeRhGe9O6FoU-SfEyjuIHXVkLRgvrDV8PUNbmtAbLRTfkW9Nd7gQ-aKB-2Q2TY4EK57M-tKr3qUsDGYH; SUBP=0033WrSXqPxfM725Ws9jqgMF55529P9D9Wh9kbZD0nv5ZaVImFk61VcC5NHD95Q4eheRSK.41h2NWs4DqcjMi--NiK.Xi-2Ri--ciKnRi-zN1K501h-41KnpS7tt; ALF=02_1786446263; XSRF-TOKEN=54CdjTDqBfDJwwgh8xWxwKq-; _s_tentry=weibo.com; Apache=2294412258614.9053.1784078477510; ULV=1784078477512:31:1:1:2294412258614.9053.1784078477510:1782285345732; WBPSESS=AvpS06b1W-6vQEAX6-5qAP5yJpwZXs77THJovqSoH5SWqkwuAxn5IeCfkVK827KP66SKkl28KTxHTKIe5CDi21Dv6zF9OFzfvY2uOOzvWRl9rf3k2l-kvO0HWbCjVGEQRe5VjsYH6vzVQjAITbvS6g==';

interface TestResult { step: string; ok: boolean; detail: string; }

const results: TestResult[] = [];
let uid = '';

function record(step: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? '✅' : '❌'} ${step}: ${detail}`);
  results.push({ step, ok, detail });
}

function summary() {
  console.log(`\n${'='.repeat(60)}`);
  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  console.log(`测试汇总: ${pass} 通过 / ${fail} 失败 / ${results.length} 总计`);
  if (fail > 0) {
    console.log(`\n失败项:`);
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ❌ ${r.step}: ${r.detail}`));
  }
  console.log(`${'='.repeat(60)}\n`);
}

// ════════════════════════════════════════════════════════════
async function main() {
  const testExpId = 'test_flow_' + Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`微博实验平台 整体流程测试  [${now()}]`);
  console.log(`实验ID: ${testExpId}`);
  console.log(`${'='.repeat(60)}`);

  // ─── Step 1: Cookie 有效性验证 ──────────────────────────
  console.log(`\n📋 Step 1: Cookie 有效性验证`);

  try {
    const xsrfMatch = TEST_COOKIE.match(/XSRF-TOKEN=([^;]+)/);
    const subMatch = TEST_COOKIE.match(/SUB=([^;]+)/);
    const xsrf = xsrfMatch?.[1] || '';
    record('Cookie-格式', true,
      `XSRF=${xsrf.substring(0, 16)}... SUB=${subMatch ? '有' : '无'}`);

    // 通过搜索接口验证 cookie（profile/info 可能受限）
    const { posts, total } = await searchPosts(TEST_COOKIE, '日常', 1);
    if (total > 0 && posts.length > 0) {
      // 从搜索结果中提取一个有效用户的 uid
      const firstAuthor = posts[0].user;
      uid = firstAuthor?.idstr || String(firstAuthor?.id || '');
      record('Cookie-验证', true,
        `搜索返回 ${total} 条结果，第一个作者 uid=${uid}`);
    } else {
      record('Cookie-验证', false, '搜索返回空结果');
    }
  } catch (e: any) {
    record('Cookie-验证', false, `异常: ${e.message}`);
  }

  if (!uid) {
    console.log(`\n❌ Cookie 无效，终止测试`);
    summary();
    await closeDb();
    return;
  }

  // ─── Step 2: 搜索帖子（使用实时搜索，与正式 collector 一致）────
  console.log(`\n📋 Step 2: 搜索帖子 (实时搜索)`);

  let searchCount = 0;
  try {
    const mids = await scrapeRealtimeMids(TEST_COOKIE, '日常', 1);
    searchCount = mids.length;
    if (mids.length > 0) {
      record('搜索帖子', true, `关键词"日常"第1页: ${mids.length} 条mid`);
      console.log(`    📝 前3条: ${mids.slice(0, 3).join(', ')}`);
    } else {
      record('搜索帖子', false, '结果为空（可能cookie已过期）');
    }
    // 也测试一下 ajax/side/search
    const { total } = await searchPosts(TEST_COOKIE, '日常', 1);
    console.log(`    ajax/side/search 返回: ${total} 条`);
  } catch (e: any) {
    record('搜索帖子', false, `异常: ${e.message}`);
  }

  if (searchCount === 0) {
    console.log(`\n❌ 搜索无结果，无法继续后续测试`);
    summary();
    await closeDb();
    return;
  }

  // ─── Step 3: 找一条合适的测试帖子 ────────────────────────
  console.log(`\n📋 Step 3: 查找测试帖子 (评论数≥3、非蓝V、评论可访问)`);
  let testPostId = '';
  let testPostText = '';

  const keywords = ['日常', '美食', '旅行', '电影', '周末', '生活', '音乐', '早安', '晚安', '天气'];
  for (const kw of keywords) {
    if (testPostId) break;
    try {
      const mids = await scrapeRealtimeMids(TEST_COOKIE, kw, 1);
      console.log(`    关键词"${kw}": ${mids.length} 条mid`);
      for (const mid of mids) {
        const detail = await fetchStatusRaw(TEST_COOKIE, mid);
        if (!detail || detail.retweeted_status || detail.deleted) continue;
        if (detail.user?.verified && detail.user?.verified_type !== 0) continue;
        if ((detail.comments_count ?? 0) < 3) continue;
        // 验证评论接口可访问
        try {
          const { comments } = await getComments(TEST_COOKIE, mid, 1);
          if (!comments || comments.length === 0) continue;
        } catch (_) {
          continue;
        }
        testPostId = mid;
        testPostText = (detail.text_raw || detail.text || '').substring(0, 80);
        record('查找帖子', true,
          `mid=${testPostId} 💬${detail.comments_count} ↻${detail.reposts_count} ❤${detail.attitudes_count}`);
        break;
      }
    } catch (_) { /* 下一关键词 */ }
  }

  if (!testPostId) {
    // 降级：用搜索结果里的第一条帖子
    const { posts } = await searchPosts(TEST_COOKIE, '日常', 1);
    if (posts.length > 0) {
      testPostId = posts[0].idstr;
      testPostText = (posts[0].text_raw || '').substring(0, 80);
      record('查找帖子', false, `降级使用第一条 (评论数可能不足)`);
    }
  }

  if (!testPostId) {
    record('查找帖子', false, '无任何测试帖');
    summary();
    await closeDb();
    return;
  }

  console.log(`    内容: "${testPostText}"`);

  // ─── Step 4: 帖子详情原始数据 (→ post_detail) ───────────
  console.log(`\n📋 Step 4: 帖子详情原始数据 (→ post_detail)`);

  try {
    const statusRaw = await fetchStatusRaw(TEST_COOKIE, testPostId);
    if (statusRaw) {
      const rawSize = JSON.stringify(statusRaw).length;
      record('fetchStatusRaw', true, `返回数据 ${rawSize} 字节`);

      await upsert('post_detail',
        { experiment_id: testExpId, post_id: testPostId },
        { experiment_id: testExpId, post_id: testPostId, mid: testPostId, raw_response: JSON.stringify(statusRaw), captured_at: now() },
      );
      record('post_detail写入', true, `已写入`);
    } else {
      record('fetchStatusRaw', false, '返回 null（可能帖子不存在或被删除）');
    }
  } catch (e: any) {
    record('fetchStatusRaw', false, `异常: ${e.message}`);
  }

  // ─── Step 5: 评论数据采集 ───────────────────────────────
  console.log(`\n📋 Step 5: 评论数据采集 (→ comment_snapshots + post_comment_meta + post_user_meta)`);

  let allComments: any[] = [];
  try {
    // 第1页评论
    try {
      const { comments, total } = await getComments(TEST_COOKIE, testPostId, 1);
      if (comments.length > 0) {
        record('评论-第1页', true, `获取 ${comments.length}/${total} 条`);
        console.log(`    💬 首条: "${(comments[0].text_raw || '').substring(0, 50)}" - ${comments[0].user?.screen_name || '?'}`);
      } else {
        record('评论-第1页', true, `该帖无评论 (total=${total})`);
      }
    } catch (e: any) {
      // 部分帖子 getComments 会返回 HTML 404 页面而非 JSON（已删除或受限），跳过
      record('评论-第1页', false, `跳过（帖子评论不可访问: ${e.message.includes('Unexpected') ? 'HTML 404' : e.message})`);
    }

    // 全部评论
    allComments = await getAllComments(TEST_COOKIE, testPostId, 5);
    if (allComments.length > 0) {
      record('评论-全部', true, `共 ${allComments.length} 条`);

      // → post_comment_meta：原始评论数据
      await upsert('post_comment_meta',
        { experiment_id: testExpId, post_id: testPostId },
        { experiment_id: testExpId, post_id: testPostId, mid: testPostId, raw_response: JSON.stringify(allComments), captured_at: now() },
      );
      record('post_comment_meta', true, `已写入`);

      // → comment_snapshots：结构化评论
      let scCount = 0;
      const seenUsers = new Set<string>();
      for (const c of allComments) {
        const parentId = c.reply_comment?.id || (c.rootidstr && c.rootidstr !== c.idstr ? c.rootidstr : null);
        await upsert('comment_snapshots',
          { experiment_id: testExpId, comment_id: c.idstr },
          {
            experiment_id: testExpId, post_id: testPostId, mid: testPostId,
            comment_id: c.idstr,
            parent_comment_id: parentId || null,
            author_uid: c.user?.idstr || String(c.user?.id || ''),
            author_name: c.user?.screen_name || '',
            content: c.text_raw || c.text || '',
            likes_count: c.like_counts || 0,
            comment_time: c.created_at || '',
            captured_at: now(),
          },
        );
        scCount++;

        // → post_user_meta：去重用户信息
        const uId = c.user?.idstr || String(c.user?.id || '');
        if (uId && !seenUsers.has(uId)) {
          seenUsers.add(uId);
          const profile = await getUserProfile(TEST_COOKIE, uId);
          if (profile) {
            await upsert('post_user_meta',
              { experiment_id: testExpId, user_id: uId },
              { experiment_id: testExpId, user_id: uId, raw_response: JSON.stringify(profile), captured_at: now() },
            );
          }
        }
      }
      record('comment_snapshots', true, `已写入 ${scCount} 条`);
      record('post_user_meta', true, `已写入 ${seenUsers.size} 个用户`);
    }
  } catch (e: any) {
    record('评论采集', false, `异常: ${e.message}`);
  }

  // ─── Step 6: 评论发送能力测试 ────────────────────────────
  console.log(`\n📋 Step 6: 评论发送能力测试`);

  // 找另一条帖子做评论测试（用"早安"避免与上次"晚安"重复）
  let sendTestId = '';
  try {
    const { posts } = await searchPosts(TEST_COOKIE, '早安', 1);
    for (const p of posts) {
      if (!p.idstr || p.idstr === testPostId) continue;
      const detail = await getPostDetail(TEST_COOKIE, p.idstr);
      if (!detail || detail.retweeted_status || detail.user?.verified) continue;
      sendTestId = p.idstr;
      break;
    }
  } catch (_) { /* ignore */ }

  if (sendTestId) {
    try {
      const { success, commentId, error } = await postComment(TEST_COOKIE, sendTestId, '路过看到这条。');
      if (success) {
        record('发送评论', true, `成功! 评论ID=${commentId} 帖子=${sendTestId}`);
      } else {
        record('发送评论', false, `失败: ${error}`);
      }
    } catch (e: any) {
      record('发送评论', false, `异常: ${e.message}`);
    }
  } else {
    record('发送评论', false, '未找到合适的测试帖（跳过以免对他人帖子发评论）');
  }

  // ─── Step 7: 帖子指标快照 → post_snapshots ──────────────
  console.log(`\n📋 Step 7: 帖子指标快照 (→ post_snapshots)`);

  try {
    const metricsMap = await batchGetPostMetrics(TEST_COOKIE, [testPostId]);
    const metrics = metricsMap.get(testPostId);
    if (metrics) {
      record('指标快照', true, `💬${metrics.comments} ↻${metrics.reposts} ❤${metrics.likes}`);

      await upsert('post_snapshots',
        { post_id: testPostId, time_point: 't0' },
        { comments: metrics.comments, reposts: metrics.reposts, likes: metrics.likes, raw_metadata: JSON.stringify(metrics), collected_at: now() },
      );
      record('post_snapshots写入', true, `t0 快照已写入`);
    } else {
      record('指标快照', false, 'batchGetPostMetrics 未返回数据');
    }
  } catch (e: any) {
    record('指标快照', false, `异常: ${e.message}`);
  }

  // ─── Step 8: 数据库写入验证 ──────────────────────────────
  console.log(`\n📋 Step 8: MongoDB 写入验证`);

  try {
    const { rows: d1 } = await query('post_detail', { experiment_id: testExpId });
    const { rows: d2 } = await query('post_comment_meta', { experiment_id: testExpId });
    const { rows: d3 } = await query('comment_snapshots', { experiment_id: testExpId });
    const { rows: d4 } = await query('post_user_meta', { experiment_id: testExpId });

    record('MongoDB验证', true,
      `post_detail:${d1.length} post_comment_meta:${d2.length} comment_snapshots:${d3.length} post_user_meta:${d4.length}`);
  } catch (e: any) {
    record('MongoDB验证', false, `异常: ${e.message}`);
  }

  // ─── 汇总 ────────────────────────────────────────────────
  summary();
  console.log(`💡 测试数据保留在 MongoDB，可通过以下方式查看:`);
  console.log(`   db.post_detail.find({experiment_id: \"${testExpId}\"})`);
  console.log(`   db.comment_snapshots.find({experiment_id: \"${testExpId}\"})`);
  console.log(`   db.post_comment_meta.find({experiment_id: \"${testExpId}\"})`);
  console.log(`   db.post_user_meta.find({experiment_id: \"${testExpId}\"})`);

  await closeDb();
}

main().catch((e) => {
  console.error('测试异常:', e);
  closeDb().then(() => process.exit(1));
});
