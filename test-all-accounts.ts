/**
 * 全链路巡检测试
 * 对每个活跃账号测试：Cookie有效性 → 搜索帖子 → 发表评论 → 用户信息
 *
 * 用法: pnpm exec tsx test-all-accounts.ts
 */
import { getDb, query, closeDb } from './src/lib/db';

const TEST_POST_ID = '4462762761612094';
const TEST_COMMENT = '测试';

function getXsrf(cookies: string): string {
  const m = cookies.match(/XSRF-TOKEN=([^;]+)/);
  return m ? m[1] : '';
}

function buildHeaders(cookies: string, extra: Record<string, string> = {}): Record<string, string> {
  const xsrf = getXsrf(cookies);
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Cookie: cookies,
    'X-XSRF-TOKEN': xsrf,
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://weibo.com/',
    Accept: 'application/json',
    ...extra,
  };
}

interface Account {
  id: string;
  nickname: string;
  weibo_uid: string;
  cookie: string;
  daily_comment_count: number;
  max_daily_comments: number;
}

interface TestResult {
  account: string;
  uid: string;
  profile: string;
  search: string;
  comment: string;
  userinfo: string;
}

async function run() {
  const { rows }: { rows: Account[] } = await query<Account>(
    'weibo_accounts',
    { status: 'active' },
    { sort: { updated_at: -1 } },
  );

  console.log(`\n========== 微博账号全链路巡检 ==========`);
  console.log(`活跃账号数: ${rows.length}`);
  console.log(`测试博文: ${TEST_POST_ID}`);
  console.log(`时间: ${new Date().toLocaleString()}\n`);

  const results: TestResult[] = [];

  for (const a of rows) {
    const hd = buildHeaders(a.cookie);
    console.log(`── ${a.nickname} (uid: ${a.weibo_uid}) ──────────────`);

    const result: TestResult = {
      account: a.nickname,
      uid: a.weibo_uid,
      profile: '❓',
      search: '❓',
      comment: '❓',
      userinfo: '❓',
    };

    // 测试1: profile/info（验证Cookie是否有效）
    try {
      const r1 = await fetch(`https://weibo.com/ajax/profile/info?uid=${a.weibo_uid}`, { headers: hd });
      const d1: any = await r1.json();
      if (d1.ok === 1 && d1.data?.user) {
        const u = d1.data.user;
        result.profile = `✅ 粉丝:${u.followers_count} 关注:${u.friends_count} 博文:${u.statuses_count}`;
        result.userinfo = `✅ ${u.screen_name || u.name} 简介:${(u.description || '').substring(0, 30)}`;
      } else if (d1.ok === 0 && d1.url?.includes('passport')) {
        result.profile = '❌ Cookie已过期(需重新登录)';
      } else {
        result.profile = `❌ retcode:${d1.ok} msg:${(d1.msg || '').substring(0, 40)}`;
      }
    } catch (e: any) {
      result.profile = `❌ 网络错误: ${e.message}`;
    }
    console.log(`  ① 登录态: ${result.profile}`);

    // 测试2: side/search（搜索帖子）
    try {
      const r2 = await fetch('https://weibo.com/ajax/side/search?q=%E6%97%A5%E5%B8%B8', {
        headers: { ...hd, Referer: 'https://s.weibo.com/' },
      });
      const d2: any = await r2.json();
      const posts = (d2?.data?.users || []).filter((u: any) => u.status);
      result.search = posts.length > 0 ? `✅ 搜索到 ${posts.length} 条相关帖子` : '⚠️ 0条结果';
    } catch (e: any) {
      result.search = `❌ 网络错误: ${e.message}`;
    }
    console.log(`  ② 搜索帖子: ${result.search}`);

    // 测试3: comments/create（发送评论）
    try {
      const xsrf = getXsrf(a.cookie);
      const formData = new URLSearchParams();
      formData.append('id', TEST_POST_ID);
      formData.append('comment', TEST_COMMENT);
      formData.append('mid', TEST_POST_ID);
      formData.append('st', xsrf);

      const r3 = await fetch('https://weibo.com/ajax/comments/create', {
        method: 'POST',
        headers: {
          ...buildHeaders(a.cookie),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });
      const d3: any = await r3.json();

      if (d3.ok === 1 && d3.data) {
        const cid = d3.data.idstr || d3.data.comment?.idstr || String(d3.data.id);
        result.comment = `✅ commentId:${cid}`;
      } else if (d3.ok === 0 && (d3.msg || '').includes('频繁')) {
        result.comment = `⚠️ 发送频繁，需等待`;
      } else if (d3.ok === 0 && (d3.msg || '').includes('验证码')) {
        result.comment = '⚠️ 触发验证码（风控）';
      } else {
        const msg = d3.msg || d3.error || `retcode:${d3.ok}`;
        result.comment = `❌ ${msg}`;
      }
    } catch (e: any) {
      result.comment = `❌ 网络错误: ${e.message}`;
    }
    console.log(`  ③ 发表评论: ${result.comment}`);

    results.push(result);
    console.log('');
  }

  // 汇总
  console.log('========== 汇总 ==========');
  const pass = results.filter(r => r.profile.startsWith('✅'));
  const failProfile = results.filter(r => !r.profile.startsWith('✅'));
  const okSearch = results.filter(r => r.search.startsWith('✅'));
  const okComment = results.filter(r => r.comment.startsWith('✅'));

  console.log(`\n📊 统计:`);
  console.log(`  Cookie有效: ${pass.length}/${results.length}`);
  console.log(`  搜索正常:   ${okSearch.length}/${results.length}`);
  console.log(`  评论正常:   ${okComment.length}/${results.length}`);

  if (failProfile.length > 0) {
    console.log(`\n🔴 登录态失效账号:`);
    for (const r of failProfile) {
      console.log(`  - ${r.account} (uid:${r.uid}): ${r.profile}`);
    }
  }

  if (okComment.length < results.length && failProfile.length === 0) {
    console.log(`\n🟡 评论异常（非Cookie问题）:`);
    for (const r of results.filter(r => !r.comment.startsWith('✅'))) {
      console.log(`  - ${r.account}: ${r.comment}`);
    }
  }

  if (pass.length === results.length && okSearch.length === results.length && okComment.length === results.length) {
    console.log(`\n🎉 全部 ${results.length} 个账号全链路通过！`);
  }

  await closeDb();
}

run().catch((e) => { console.error(e); process.exit(1); });
