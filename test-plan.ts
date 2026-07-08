/**
 * 微博实验平台系统集成测试计划
 * ============================================================================
 *
 * 测试目标：验证系统全链路能否正常运行
 *   - 2个"仅采集"账号：负责搜索帖子 + 定时采集转赞评数据
 *   - 2个"可评论"账号：每个账号发10条评论（按 control/low/high 三组分配）
 *   - 每2小时采集一次评论帖子的转赞评快照
 *
 * 测试持续时间：约 12 小时 (t0 ~ t12h)
 *
 * ============================================================================
 * 阶段一：环境预检 (pre_check)
 * ============================================================================
 * 1. 从 MongoDB weibo_accounts 表读取所有 active 账号
 * 2. 逐一检测每个账号：
 *    a. Cookie 有效期（profile/info 接口）
 *    b. 搜索能力（side/search?q=日常 接口）
 *    c. 评论能力（statuses/show + comments/create 连通性，不实际发表）
 * 3. 所有通过预检的账号均可评论+采集（不再区分角色）
 * 4. 重置所有账号 daily_comment_count = 0
 *
 * ============================================================================
 * 阶段二：帖子筛选 & 实验创建 (screening)
 * ============================================================================
 * 1. 使用 s.weibo.com/realtime 实时搜索（15关键词/每词2页）
 * 2. 逐条 statuses/show 获取真实数据并筛选：
 *    - 12小时内发布、原创、非蓝V、≥8汉字、评论数10-500、粉丝≤50万
 *    - 排除营销/政治/敏感关键词
 * 3. 随机选取 30 篇（比需求多 50% 容错，避免帖子关闭评论导致不足）
 * 4. 按 1:1:1 比例随机分配 control/low/high 三组
 * 5. 为 low/high 组匹配评论模板（从 comment_templates 表）
 * 6. 创建 experiment_run，写入 posts 和 intervention_logs
 *
 * ============================================================================
 * 阶段三：基线采集 t0 (collect_t0)
 * ============================================================================
 * 1. 使用 collector 账号的 Cookie
 * 2. 对所有帖子逐一调用 statuses/show 获取初始转赞评
 * 3. 存入 post_snapshots（time_point = 't0'）
 *
 * ============================================================================
 * 阶段四：批量评论发送 (send_comments)
 * ============================================================================
 * 1. 遍历 intervention_logs（status='pending'，非 control 组）
 * 2. 轮询分配 commenting 账号，间隔 5-15 秒
 * 3. 失败自动换另一个账号重试（双账号容错）
 * 4. 记录评论结果并更新 daily_comment_count
 *
 * ============================================================================
 * 阶段五：定时监控 (monitoring)
 * ============================================================================
 * 时间点: t2h, t4h, t6h, t8h, t10h, t12h
 *
 * 每个时间点：
 * 1. 使用 collector 账号的 Cookie（两个账号各采集一半，减少单账号负载）
 * 2. 对所有帖子调用 batchGetPostMetrics（逐个请求 + 间隔 0.5-1.5s）
 * 3. 存入 post_snapshots（time_point = 't2h'/'t4h'/...）
 * 4. 打印采集摘要：时间点、成功/失败数、各组的平均转赞评
 *
 * ============================================================================
 * 阶段六：结果验证 (verify)
 * ============================================================================
 * 1. 检查 intervention_logs：
 *    - sent 数量 = 14（control 组不发评论，low 7 + high 7 ≈ 14 条）
 *    - 无 pending 状态的日志（全部已处理）
 * 2. 检查 post_snapshots：
 *    - 每个时间点都有 20 条快照（或接近）
 *    - t0 基线存在
 * 3. 检查 weibo_accounts：
 *    - commenting 账号 daily_comment_count ≈ 10
 *    - collector 账号 daily_comment_count = 0（未发送评论）
 * 4. 计算 delta = t12h 指标 - t0 指标
 * 5. 打印验证报告
 *
 * ============================================================================
 * 成功判定标准
 * ============================================================================
 * ✅ 4 个账号全部通过预检（Cookie 有效、搜索正常）
 * ✅ 2 个 commenting 账号评论发送成功率 ≥ 80%（≥11/14 成功）
 * ✅ 监控数据覆盖率 ≥ 80%（每个时间点）
 * ✅ t0 ~ t12h 至少 4 个时间点有完整快照
 * ✅ MongoDB 数据一致性：posts ↔ intervention_logs ↔ post_snapshots 关联完整
 *
 * ============================================================================
 * 失败处理
 * ============================================================================
 * - 账号 Cookie 过期 → 跳过该账号，标记状态
 * - 评论发送触发风控/验证码 → 暂停 5 分钟重试，累计 3 次失败则跳过
 * - 数据采集时帖子被删除/不可见 → 记录跳过，不阻塞其他帖子
 * - 网络超时 → 重试 2 次，间隔递增（1s/3s/5s）
 *
 * ============================================================================
 * 使用方法
 * ============================================================================
 *   # 方式1: 依次执行所有阶段（人工在各阶段间确认）
 *   npx tsx test-plan.ts
 *
 *   # 方式2: 指定阶段（调试用）
 *   npx tsx test-plan.ts --phase=pre_check
 *   npx tsx test-plan.ts --phase=screening
 *   npx tsx test-plan.ts --phase=collect_t0
 *   npx tsx test-plan.ts --phase=send_comments
 *   npx tsx test-plan.ts --phase=monitoring  # 自动循环 t2h→t12h
 *
 *   # 方式3: 全自动（无人值守，每2小时自动执行监控）
 *   npx tsx test-plan.ts --auto
 */

/* ================================================================
 * 以下是实现代码（分阶段独立函数）
 * ================================================================ */

import { getDb, query, insert, updateOne, upsert, closeDb } from './src/lib/db';
import {
  batchGetPostMetrics,
} from './src/lib/weibo-api';
import { randomizeAndGroup, assignTemplates } from './src/lib/experiment-engine';

// ─── 类型定义 ──────────────────────────────────────────────

interface Account {
  id: string;
  nickname: string;
  weibo_uid: string;
  cookie: string;
  daily_comment_count: number;
  max_daily_comments: number;
  status: string;
}

interface TestResult {
  account: string;
  uid: string;
  profile: boolean;
  search: boolean;
  canComment: boolean;
  commentError?: string;
}

interface ScreeningPost {
  postId: string;
  postUrl: string;
  content: string;
  authorUid: string;
  authorName: string;
  followers: number;
  commentsCount: number;
  repostsCount: number;
  likesCount: number;
  publishedAt: string;
}

// ─── 工具函数 ──────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function getXsrf(cookies: string): string {
  const m = cookies.match(/XSRF-TOKEN=([^;]+)/);
  return m ? m[1] : '';
}

function buildHeaders(cookies: string, extra: Record<string, string> = {}) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Cookie: cookies,
    'X-XSRF-TOKEN': getXsrf(cookies),
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://weibo.com/',
    Accept: 'application/json',
    ...extra,
  };
}

function now() { return new Date().toISOString(); }
function ts() { return new Date().toLocaleString(); }

const MONITOR_POINTS = ['t2h', 't4h', 't6h', 't8h', 't10h', 't12h'];
const SEARCH_KEYWORDS = ['日常', '分享', '生活', '美食', '旅行', '今天', '感觉', '真的', '最近', '突然', '开心', '好吃', '好看', '回家', '周末'];

// ─── s.weibo.com/realtime 网页抓取 ──────────────────────────

async function scrapeRealtimeMids(cookie: string, keyword: string, page: number = 1): Promise<string[]> {
  const url = `https://s.weibo.com/realtime?q=${encodeURIComponent(keyword)}&page=${page}`;
  const xsrf = getXsrf(cookie);
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Cookie: cookie,
      Referer: 'https://s.weibo.com/',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!resp.ok) return [];
  const html = await resp.text();
  return [...html.matchAll(/mid="(\d+)"/g)].map(m => m[1]);
}

// ─── 阶段一：环境预检 ──────────────────────────────────────

async function phase_pre_check(): Promise<{
  allAccounts: Account[];
  results: TestResult[];
  ok: boolean;
}> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`阶段一：环境预检  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const { rows: accounts } = await query<Account>('weibo_accounts', { status: 'active' });
  console.log(`活跃账号总数: ${accounts.length}`);

  const results: TestResult[] = [];

  for (const a of accounts) {
    const hd = buildHeaders(a.cookie);
    console.log(`\n── 检测 ${a.nickname} (uid: ${a.weibo_uid}) ──`);

    const tr: TestResult = { account: a.nickname, uid: a.weibo_uid, profile: false, search: false, canComment: false };

    // 检测1: Cookie 有效性
    try {
      const r1 = await fetch(`https://weibo.com/ajax/profile/info?uid=${a.weibo_uid}`, { headers: hd });
      const d1: any = await r1.json();
      tr.profile = d1.ok === 1 && !!d1.data?.user;
      console.log(`  ① Cookie: ${tr.profile ? '✅ 有效' : '❌ 失效'}`);
    } catch (e: any) {
      console.log(`  ① Cookie: ❌ ${e.message}`);
    }

    // 检测2: 搜索能力
    try {
      const r2 = await fetch('https://weibo.com/ajax/side/search?q=%E6%97%A5%E5%B8%B8&page=1', {
        headers: { ...hd, Referer: 'https://s.weibo.com/' },
      });
      const d2: any = await r2.json();
      const posts = (d2?.data?.users || []).filter((u: any) => u.status);
      tr.search = posts.length > 0;
      console.log(`  ② 搜索:  ${tr.search ? '✅ 正常' : '⚠️ 无结果'}`);
    } catch (e: any) {
      console.log(`  ② 搜索:  ❌ ${e.message}`);
    }

    // 检测3: 评论连通性（不实际发表）
    try {
      const r3 = await fetch(`https://weibo.com/ajax/statuses/show?id=${a.weibo_uid}`, { headers: hd });
      tr.canComment = r3.status === 200;
      if (tr.canComment) {
        console.log(`  ③ 评论:  ✅ 接口可达`);
      } else {
        tr.commentError = `statuses/show 状态 ${r3.status}`;
        console.log(`  ③ 评论:  ❌ ${tr.commentError}`);
      }
    } catch (e: any) {
      tr.canComment = false;
      tr.commentError = e.message;
      console.log(`  ③ 评论:  ❌ ${tr.commentError}`);
    }

    results.push(tr);
  }

  // 所有通过预检的账号均可评论+采集
  const passAccounts = accounts.filter((a, i) => results[i]?.profile && results[i]?.search);
  const allAccounts = passAccounts;

  console.log(`\n──── 账号状态 ────`);
  console.log(`  可用账号 (${allAccounts.length}): ${allAccounts.map(a => a.nickname).join(', ')}`);
  console.log(`  所有账号均可评论 + 采集`);

  const ok = allAccounts.length >= 2;
  if (!ok) {
    console.log(`\n❌ 预检不通过：需要≥2个可用账号`);
    console.log(`   实际: ${allAccounts.length}`);
  }

  // 重置每日计数
  for (const a of allAccounts) {
    await updateOne('weibo_accounts', { id: a.id }, { daily_comment_count: 0 });
  }
  console.log(`\n✅ 已重置所有账号的 daily_comment_count`);

  return { allAccounts, results, ok };
}

// ─── 阶段二：帖子筛选 & 实验创建 ────────────────────────────

async function phase_screening(
  allAccounts: Account[],
): Promise<{ experimentId: string; posts: ScreeningPost[]; spares: ScreeningPost[] } | null> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`阶段二：帖子筛选  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);
  console.log(`可用账号: ${allAccounts.map(a => a.nickname).join(', ')}`);

  const EXCLUDE_KW = [
    // 敏感/政治
    '热搜', '政治', '灾难', '事故', '自杀', '自伤', '未成年人',
    // 营销/广告
    '抽奖', '转发抽奖', '福利', '加群', '广告', '推广', '优惠', '促销',
    '秒杀', '拼团', '红包', '赚钱', '兼职', '日赚', '投资', '理财',
    '股票', '基金', '保险', '代购', '微商', '加盟', '招商',
    // 涨粉/引流
    '私信我', '关注我', '求关注', '互粉', '涨粉', '求赞', '互赞',
    '课程', '训练营', '领取', '免费领', '限时',
    // 医疗/法律
    '医疗', '法律咨询', '金融',
  ];

  // 第一轮：从 s.weibo.com/realtime 抓取所有 mid
  const allMids = new Set<string>();
  for (const kw of SEARCH_KEYWORDS) {
    for (let page = 1; page <= 2; page++) {
      const ci = (allMids.size) % allAccounts.length;
      try {
        const mids = await scrapeRealtimeMids(allAccounts[ci].cookie, kw, page);
        for (const m of mids) allMids.add(m);
        console.log(`  实时搜索 "${kw}" 第${page}页: ${mids.length} 个mid (累计${allMids.size})`);
      } catch { console.log(`  实时搜索 "${kw}" 第${page}页: 失败`); break; }
      await sleep(600 + Math.random() * 800);
    }
  }
  const mids = [...allMids];
  console.log(`\n  去重后共 ${mids.length} 个候选帖子`);
  if (mids.length === 0) { console.log(`  ❌ 无候选帖子`); return null; }

  // 第二轮：逐条 statuses/show 获取真实数据并筛选
  const passed: ScreeningPost[] = [];
  const cutoff = Date.now() - 12 * 3600 * 1000;
  console.log(`  逐条 statuses/show 获取指标并筛选 (目标≥20篇)...`);

  for (let i = 0; i < mids.length; i++) {
    const mid = mids[i];
    const ci = i % allAccounts.length;
    try {
      const mr = await fetch(`https://weibo.com/ajax/statuses/show?id=${mid}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Cookie: allAccounts[ci].cookie,
          'X-XSRF-TOKEN': getXsrf(allAccounts[ci].cookie),
          'X-Requested-With': 'XMLHttpRequest',
          Referer: 'https://weibo.com/',
          Accept: 'application/json',
        },
      });
      const md: any = await mr.json();
      if (!md || md.ok === 0) continue;

      const content = md.text_raw || md.text || '';
      const postTime = new Date(md.created_at || '').getTime();
      const cc = md.comments_count || 0;
      const rp = md.reposts_count || 0;
      const lk = md.attitudes_count || 0;
      const followers = md.user?.followers_count || 0;
      const vt = md.user?.verified_type ?? -1;
      const ret = !!md.retweeted_status;
      const hanzi = (content.match(/[\u4e00-\u9fff]/g) || []).length;
      const authorUid = String(md.user?.id || '');
      const authorName = md.user?.screen_name || '';

      if (postTime < cutoff) continue;
      if (ret) continue;
      if (vt > 0) continue;
      if (hanzi < 8) continue;
      if (cc < 10 || cc > 500) continue;
      if (followers >= 500_000) continue;
      if (EXCLUDE_KW.some(kw => content.toLowerCase().includes(kw.toLowerCase()))) continue;

      passed.push({
        postId: mid,
        postUrl: `https://weibo.com/${authorUid}/${mid}`,
        content,
        authorUid,
        authorName,
        followers,
        commentsCount: cc,
        repostsCount: rp,
        likesCount: lk,
        publishedAt: md.created_at,
      });
    } catch { /* 跳过 */ }
    await sleep(400 + Math.random() * 800);
    if ((i + 1) % 10 === 0) console.log(`    进度: ${i + 1}/${mids.length} (通过${passed.length}篇)`);
  }
  console.log(`  筛选通过: ${passed.length} 篇`);
  if (passed.length < 20) {
    console.log(`  ❌ 通过筛选的帖子不足20篇 (${passed.length}/20)，无法继续`);
    return null;
  }

  // 用户去重
  const seenUid = new Set<string>();
  const deduped = passed.filter(p => {
    if (seenUid.has(p.authorUid)) return false;
    seenUid.add(p.authorUid);
    return true;
  });
  console.log(`  用户去重后: ${deduped.length} 篇`);

  // 随机选 35 篇（比需要的 20 篇多选 75% 容错，避免部分帖子关闭评论导致不足）
  const shuffled = [...deduped].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 35);
  const spares = shuffled.slice(35); // 剩余的作为备选池（评论失败时回补）
  console.log(`  最终选取: ${selected.length} 篇 (含容错)`);
  console.log(`  备选池: ${spares.length} 篇`);

  // 创建实验：用 experiment-engine 分组
  const { grouped, config } = randomizeAndGroup(selected as any, selected.length);
  const withTemplates = await assignTemplates(grouped as any);

  const exp = await insert('experiment_runs', {
    user_id: 'admin',
    date: new Date().toISOString().split('T')[0],
    status: 'screening',
    total_posts: config.totalPosts,
  });
  if (!exp) { console.log('  ❌ 创建实验失败'); return null; }
  const experimentId = String(exp.id);

  // 写入 posts 和 intervention_logs
  for (const item of withTemplates) {
    const post = await insert('posts', {
      user_id: 'admin',
      experiment_id: experimentId,
      post_id: (item as any).post.postId,
      post_url: (item as any).post.postUrl,
      content: (item as any).post.content,
      author_uid: (item as any).post.authorUid,
      author_name: (item as any).post.authorName,
      followers: (item as any).post.followers,
      comments_count: (item as any).post.commentsCount,
      reposts_count: (item as any).post.repostsCount,
      likes_count: (item as any).post.likesCount,
      post_group: item.group,
      published_at: (item as any).post.publishedAt,
    });

    if (post) {
      await insert('intervention_logs', {
        experiment_id: experimentId,
        post_id: String(post.id),
        post_group: item.group,
        comment_template: (item as any).templateId ? String((item as any).templateId) : null,
        comment_content: item.commentContent,
        status: 'pending',
      });
    }
  }

  console.log(`\n✅ 实验创建完成`);
  console.log(`   experimentId: ${experimentId}`);
  console.log(`   control: ${config.controlCount}  |  low: ${config.lowCount}  |  high: ${config.highCount}`);
  console.log(`   待发评论: ${withTemplates.filter(i => i.group !== 'control').length} 条`);

  return { experimentId, posts: selected, spares };
}

// ─── 阶段三：基线采集 t0 ────────────────────────────────────

async function phase_collect_t0(
  experimentId: string,
  collector: Account,
): Promise<number> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`阶段三：基线采集 t0  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const { rows: posts } = await query<any>('posts', { experiment_id: experimentId });
  console.log(`帖子总数: ${posts.length}`);
  console.log(`采集账号: ${collector.nickname}\n`);

  const metricsMap = await batchGetPostMetrics(collector.cookie, posts.map((p: any) => p.post_id));
  let saved = 0;

  for (const post of posts) {
    const metrics = metricsMap.get(post.post_id);
    if (!metrics) { console.log(`  ⚠️ 获取失败: ${post.post_id}`); continue; }
    await upsert(
      'post_snapshots',
      { post_id: String(post.id), time_point: 't0' },
      {
        comments: metrics.comments,
        reposts: metrics.reposts,
        likes: metrics.likes,
        collected_at: now(),
      },
    );
    saved++;
  }

  console.log(`\n✅ t0 采集完成: ${saved}/${posts.length} 篇`);
  return saved;
}

// ─── 阶段四：批量评论发送 ────────────────────────────────────

async function sendOneComment(postId: string, content: string, cookie: string): Promise<{ ok: boolean; cid?: string; err?: string }> {
  try {
    const xsrf = getXsrf(cookie);
    const fd = new URLSearchParams({ id: postId, comment: content, mid: postId, st: xsrf });
    const resp = await fetch('https://weibo.com/ajax/comments/create', {
      method: 'POST',
      headers: { ...buildHeaders(cookie), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fd.toString(),
    });
    const text = await resp.text();
    let data: any;
    try { data = JSON.parse(text); } catch { return { ok: false, err: text.substring(0, 100) }; }
    if (data.ok === 1 && data.data) {
      const cid = data.data.idstr || data.data.comment?.idstr || String(data.data.id);
      return { ok: true, cid };
    }
    return { ok: false, err: data.msg || data.error || `retcode:${data.ok}` };
  } catch (e: any) {
    return { ok: false, err: e.message };
  }
}

async function phase_send_comments(
  experimentId: string,
  commenters: Account[],
  spares: ScreeningPost[],
): Promise<{ sent: number; failed: number }> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`阶段四：批量评论发送  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const { rows: logs } = await query<any>('intervention_logs', {
    experiment_id: experimentId,
    status: 'pending',
    post_group: { $ne: 'control' as any },
  });

  console.log(`待发评论: ${logs.length} 条`);
  console.log(`评论账号: ${commenters.map(a => a.nickname).join(', ')}\n`);

  let sent = 0, failed = 0, accIdx = 0;

  for (const log of logs) {
    const primary = commenters[accIdx % commenters.length];
    accIdx++;

    const post = await (async () => {
      const { rows } = await query<any>('posts', { id: log.post_id });
      return rows[0];
    })();

    if (!post) {
      await updateOne('intervention_logs', { id: String(log.id) }, { status: 'failed', error_message: '帖子不存在' });
      failed++;
      console.log(`  ❌ ${log.id}: 帖子不存在`);
      continue;
    }

    console.log(`  📤 [${primary.nickname}] → ${post.post_id.substring(0, 10)}... "${log.comment_content}"`);

    // 第一次尝试
    let r = await sendOneComment(post.post_id, log.comment_content, primary.cookie);

    // 失败则换另一个账号重试
    if (!r.ok) {
      console.log(`    ⚠️ 首试失败: ${r.err}`);
      const fallback = commenters.find(a => a.weibo_uid !== primary.weibo_uid);
      if (fallback) {
        console.log(`    🔄 换 [${fallback.nickname}] 重试...`);
        r = await sendOneComment(post.post_id, log.comment_content, fallback.cookie);
      }
    }

    if (r.ok && r.cid) {
      await updateOne('intervention_logs', { id: String(log.id) }, {
        status: 'sent',
        sent_at: now(),
        weibo_comment_id: r.cid,
        account_id: primary.id,
      });
      sent++;
      console.log(`    ✅ commentId: ${r.cid}`);
    } else {
      // 标记失败
      await updateOne('intervention_logs', { id: String(log.id) }, {
        status: 'failed',
        error_message: r.err || '未知错误',
        account_id: primary.id,
      });
      failed++;
      console.log(`    ❌ ${r.err}`);

      // 备选回补：从备选池取新帖重试
      if (spares.length > 0 && log.post_group !== 'control') {
        const spare = spares.shift()!;
        console.log(`    🔄 备选回补: ${spare.postId.substring(0, 10)}... [${spare.authorName}]`);
        try {
          const sparePost = await insert('posts', {
            user_id: 'admin',
            experiment_id: experimentId,
            post_id: spare.postId,
            post_url: spare.postUrl,
            content: spare.content,
            author_uid: spare.authorUid,
            author_name: spare.authorName,
            followers: spare.followers,
            comments_count: spare.commentsCount,
            reposts_count: spare.repostsCount,
            likes_count: spare.likesCount,
            post_group: log.post_group,
            published_at: spare.publishedAt,
          });
          if (sparePost) {
            const spareLog = await insert('intervention_logs', {
              experiment_id: experimentId,
              post_id: String(sparePost.id),
              post_group: log.post_group,
              comment_template: log.comment_template,
              comment_content: log.comment_content,
              status: 'pending',
            });
            if (spareLog) {
              const sr = await sendOneComment(spare.postId, log.comment_content, primary.cookie);
              if (!sr.ok) {
                const fb = commenters.find(a => a.weibo_uid !== primary.weibo_uid);
                if (fb) {
                  console.log(`    🔄 备选换 [${fb.nickname}] 重试...`);
                  const sr2 = await sendOneComment(spare.postId, log.comment_content, fb.cookie);
                  if (sr2.ok && sr2.cid) {
                    await updateOne('intervention_logs', { id: String(spareLog.id) }, {
                      status: 'sent', sent_at: now(), weibo_comment_id: sr2.cid, account_id: fb.id,
                    });
                    sent++;
                    failed--; // 回补成功
                    console.log(`    ✅ 回补成功! commentId: ${sr2.cid}`);
                  } else {
                    await updateOne('intervention_logs', { id: String(spareLog.id) }, {
                      status: 'failed', error_message: sr2.err || sr.err || '备选回补失败',
                    });
                    console.log(`    ❌ 备选回补失败`);
                  }
                } else {
                  await updateOne('intervention_logs', { id: String(spareLog.id) }, {
                    status: 'failed', error_message: sr.err || '备选回补失败',
                  });
                  console.log(`    ❌ 备选回补失败`);
                }
              } else {
                await updateOne('intervention_logs', { id: String(spareLog.id) }, {
                  status: 'sent', sent_at: now(), weibo_comment_id: sr.cid, account_id: primary.id,
                });
                sent++;
                failed--; // 回补成功
                console.log(`    ✅ 回补成功! commentId: ${sr.cid}`);
              }
            }
          }
        } catch (e: any) {
          console.log(`    ⚠️ 备选回补异常: ${e.message}`);
        }
        await sleep(3000 + Math.random() * 5000);
      }
    }

    // 更新计数
    await (async () => {
      const db = await getDb();
      await db.collection('weibo_accounts').updateOne(
        { _id: primary.id as any },
        { $inc: { daily_comment_count: 1 }, $set: { last_used_at: now() } },
      );
    })();

    await sleep(5000 + Math.random() * 10000);
  }

  console.log(`\n✅ 评论发送完成: ${sent} 成功 / ${failed} 失败`);
  return { sent, failed };
}

// ─── 阶段五：定时监控 ────────────────────────────────────────

async function phase_monitoring(
  experimentId: string,
  collectors: Account[],
): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`阶段五：定时监控  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);
  console.log(`监控时间点: ${MONITOR_POINTS.join(', ')}`);
  console.log(`采集账号: ${collectors.map(a => a.nickname).join(', ')}\n`);

  const { rows: posts } = await query<any>('posts', { experiment_id: experimentId });
  if (!posts.length) { console.log('❌ 无帖子'); return; }

  const intervals: Record<string, number> = {
    't2h': 2, 't4h': 4, 't6h': 6, 't8h': 8, 't10h': 10, 't12h': 12,
  };

  for (const point of MONITOR_POINTS) {
    const waitMinutes = intervals[point] * 60;
    const targetTime = new Date(Date.now() + waitMinutes * 60000);
    console.log(`\n⏰ 下一个时间点 ${point}: ${targetTime.toLocaleString()} (等待 ${waitMinutes} 分钟)`);
    console.log(`   (Ctrl+C 可跳过等待，立即执行采集)\n`);

    // 倒计时
    for (let min = waitMinutes; min > 0; min--) {
      process.stdout.write(`\r  剩余 ${min} 分钟...`);
      await sleep(60000); // 1 分钟
    }
    console.log('');

    // 执行采集：两个采集号各负责一半帖子
    const half = Math.ceil(posts.length / collectors.length);
    const grouped: any[][] = [];
    for (let i = 0; i < collectors.length; i++) {
      grouped.push(posts.slice(i * half, (i + 1) * half));
    }

    let saved = 0, total = 0;
    for (let i = 0; i < collectors.length; i++) {
      const acct = collectors[i];
      const batch = grouped[i];
      if (!batch || batch.length === 0) continue;
      total += batch.length;

      console.log(`  📊 ${point} [${acct.nickname}]: 采集 ${batch.length} 篇...`);
      const metricsMap = await batchGetPostMetrics(acct.cookie, batch.map((p: any) => p.post_id));

      for (const post of batch) {
        const metrics = metricsMap.get(post.post_id);
        if (!metrics) continue;
        await upsert(
          'post_snapshots',
          { post_id: String(post.id), time_point: point },
          {
            comments: metrics.comments,
            reposts: metrics.reposts,
            likes: metrics.likes,
            collected_at: now(),
          },
        );
        saved++;
      }
    }

    // 打印分组摘要
    console.log(`  ${point} 采集完成: ${saved}/${total} 篇`);
    for (const group of ['control', 'low', 'high']) {
      const gp = posts.filter((p: any) => p.post_group === group);
      if (gp.length === 0) continue;
      const { rows: snaps } = await query<any>('post_snapshots', {
        post_id: { $in: gp.map((p: any) => String(p.id)) },
        time_point: point,
      });
      const avgComments = snaps.reduce((s: number, sn: any) => s + (sn.comments || 0), 0) / (snaps.length || 1);
      const avgReposts = snaps.reduce((s: number, sn: any) => s + (sn.reposts || 0), 0) / (snaps.length || 1);
      const avgLikes = snaps.reduce((s: number, sn: any) => s + (sn.likes || 0), 0) / (snaps.length || 1);
      console.log(`    [${group}] ${snaps.length}/${gp.length}篇 | 均评论:${avgComments.toFixed(1)} 均转发:${avgReposts.toFixed(1)} 均赞:${avgLikes.toFixed(1)}`);
    }
  }

  console.log(`\n✅ 定时监控完成`);
}

// ─── 阶段六：结果验证 ────────────────────────────────────────

async function phase_verify(
  experimentId: string,
  commenters: Account[],
  collectors: Account[],
): Promise<boolean> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`阶段六：结果验证  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  let allPass = true;

  // 1. 评论发送验证
  const { rows: logs } = await query<any>('intervention_logs', { experiment_id: experimentId });
  const sentLogs = logs.filter((l: any) => l.status === 'sent');
  const controlLogs = logs.filter((l: any) => l.post_group === 'control');
  const pendingLogs = logs.filter((l: any) => l.status === 'pending');
  const nonControlLogs = logs.filter((l: any) => l.post_group !== 'control');

  console.log(`── 评论发送验证 ──`);
  console.log(`  control 组(不发评论): ${controlLogs.length}`);
  console.log(`  应发送评论: ${nonControlLogs.length}`);
  console.log(`  已发送: ${sentLogs.length}`);
  console.log(`  失败/待发: ${logs.length - sentLogs.length - controlLogs.length}`);

  const expectedSent = nonControlLogs.length;
  if (sentLogs.length >= expectedSent * 0.8) {
    console.log(`  ✅ 评论发送成功率 ≥ 80%`);
  } else {
    console.log(`  ❌ 评论发送成功率 ${(sentLogs.length / expectedSent * 100).toFixed(1)}% < 80%`);
    allPass = false;
  }

  // 2. 快照采集验证
  const { rows: posts } = await query<any>('posts', { experiment_id: experimentId });
  const allPoints = ['t0', ...MONITOR_POINTS];
  console.log(`\n── 快照采集验证 ──`);
  let passedPoints = 0;
  for (const point of allPoints) {
    const { rows: snaps } = await query<any>('post_snapshots', {
      post_id: { $in: posts.map((p: any) => String(p.id)) },
      time_point: point,
    });
    const pct = snaps.length / posts.length;
    const status = pct >= 0.8 ? '✅' : pct >= 0.5 ? '⚠️' : '❌';
    if (pct >= 0.8) passedPoints++;
    console.log(`  ${status} ${point}: ${snaps.length}/${posts.length} (${(pct * 100).toFixed(0)}%)`);
  }
  if (passedPoints >= 4) {
    console.log(`  ✅ 至少4个时间点快照完整`);
  } else {
    console.log(`  ❌ 仅${passedPoints}个时间点完整（需要≥4）`);
    allPass = false;
  }

  // 3. 账号计数验证
  console.log(`\n── 账号计数验证 ──`);
  for (const a of commenters) {
    const acc = await (async () => {
      const { rows } = await query<any>('weibo_accounts', { id: a.id });
      return rows[0];
    })();
    console.log(`  [评论] ${acc?.nickname}: daily=${acc?.daily_comment_count}/${acc?.max_daily_comments}`);
  }
  for (const a of collectors) {
    const acc = await (async () => {
      const { rows } = await query<any>('weibo_accounts', { id: a.id });
      return rows[0];
    })();
    console.log(`  [采集] ${acc?.nickname}: daily=${acc?.daily_comment_count} (应为0)`);
  }

  // 4. Delta 计算
  console.log(`\n── Delta 指标 (t12h - t0) ──`);
  for (const group of ['control', 'low', 'high']) {
    const gp = posts.filter((p: any) => p.post_group === group);
    if (gp.length === 0) continue;
    const gpIds = gp.map((p: any) => String(p.id));

    const { rows: t0Snaps } = await query<any>('post_snapshots', {
      post_id: { $in: gpIds },
      time_point: 't0',
    });
    const { rows: t12Snaps } = await query<any>('post_snapshots', {
      post_id: { $in: gpIds },
      time_point: 't12h',
    });

    const t0Avg = (arr: any[], field: string) =>
      arr.reduce((s, a) => s + (a[field] || 0), 0) / (arr.length || 1);
    const dComments = t0Avg(t12Snaps, 'comments') - t0Avg(t0Snaps, 'comments');
    const dReposts = t0Avg(t12Snaps, 'reposts') - t0Avg(t0Snaps, 'reposts');
    const dLikes = t0Avg(t12Snaps, 'likes') - t0Avg(t0Snaps, 'likes');

    console.log(`  [${group}] Δ评论:${dComments.toFixed(1)}  Δ转发:${dReposts.toFixed(1)}  Δ赞:${dLikes.toFixed(1)}`);
  }

  // 最终判定
  console.log(`\n${'='.repeat(60)}`);
  if (allPass) {
    console.log(`🎉 系统测试通过！全链路运行正常。`);
  } else {
    console.log(`⚠️ 部分检查项未通过，请查看上述详情。`);
  }
  console.log(`${'='.repeat(60)}\n`);

  return allPass;
}

// ─── 主入口 ─────────────────────────────────────────────────

async function main() {
  const phase = process.argv.find(a => a.startsWith('--phase='))?.split('=')[1];
  const autoMode = process.argv.includes('--auto');

  console.log('微博实验平台 - 系统集成测试');
  console.log(`模式: ${autoMode ? '全自动' : phase ? `单阶段[${phase}]` : '交互式'}\n`);

  if (phase) {
    // 单阶段模式
    if (phase === 'pre_check') { await phase_pre_check(); }
    else if (phase === 'monitoring') {
      const expId = process.argv.find(a => a.startsWith('--exp='))?.split('=')[1];
      if (!expId) { console.log('❌ 需要 --exp=<experimentId>'); return; }
      const { rows: accounts } = await query<Account>('weibo_accounts', { status: 'active' });
      await phase_monitoring(expId, accounts as Account[]);
    }
    else { console.log(`未知阶段: ${phase}`); }
    await closeDb();
    return;
  }

  // 全流程
  // 阶段一
  const { allAccounts, ok } = await phase_pre_check();
  if (!ok) { console.log('\n❌ 预检不通过，终止测试'); await closeDb(); return; }

  if (!autoMode) {
    console.log(`\n按 Enter 继续→阶段二（帖子筛选），Ctrl+C 退出...`);
    await new Promise<void>(r => process.stdin.once('data', () => r()));
  }

  // 阶段二
  const screening = await phase_screening(allAccounts);
  if (!screening) { console.log('\n❌ 筛选失败，终止测试'); await closeDb(); return; }
  const { experimentId, spares } = screening;

  if (!autoMode) {
    console.log(`\n按 Enter 继续→阶段三（基线采集 t0），Ctrl+C 退出...`);
    await new Promise<void>(r => process.stdin.once('data', () => r()));
  }

  // 阶段三
  await phase_collect_t0(experimentId, allAccounts[0]);

  if (!autoMode) {
    console.log(`\n按 Enter 继续→阶段四（批量评论发送），Ctrl+C 退出...`);
    await new Promise<void>(r => process.stdin.once('data', () => r()));
  }

  // 阶段四
  const { sent, failed } = await phase_send_comments(experimentId, allAccounts, spares);
  console.log(`\n评论结果: ${sent}成功 / ${failed}失败`);

  if (!autoMode) {
    console.log(`\n按 Enter 继续→阶段五（定时监控，约12小时），Ctrl+C 退出...`);
    await new Promise<void>(r => process.stdin.once('data', () => r()));
  }

  // 阶段五（定时监控 - 每2小时，共12小时）
  await phase_monitoring(experimentId, allAccounts);

  // 阶段六
  await phase_verify(experimentId, allAccounts, allAccounts);

  await closeDb();
}

main().catch(e => {
  console.error('测试异常:', e);
  process.exit(1);
});
