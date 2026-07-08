/**
 * 测试微博 API：搜索帖子 / 获取评论 / Cookie 验证
 * 运行方式：pnpm exec tsx test-weibo-api.ts
 */
import { query, closeDb } from './src/lib/db';

const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function getXsrfToken(cookies: string): string {
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  return match ? match[1] : '';
}

function headers(cookies: string): Record<string, string> {
  const xsrf = getXsrfToken(cookies);
  return {
    'User-Agent': PC_UA,
    Cookie: cookies,
    'X-XSRF-TOKEN': xsrf,
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://weibo.com/',
    Accept: 'application/json, text/plain, */*',
  };
}

async function run() {
  // 1. 获取已登录账号
  const { rows } = await query(
    'weibo_accounts',
    { status: 'active' },
    { sort: { updated_at: -1 }, limit: 1 },
  );
  if (rows.length === 0) {
    console.log('❌ 没有活跃账号');
    await closeDb();
    return;
  }

  const account: any = rows[0];
  const cookies: string = account.cookie;
  const weiboUid: string = account.weibo_uid || '';
  const xsrf = getXsrfToken(cookies);

  console.log('========================================');
  console.log('测试账号:', account.nickname, '(uid:', weiboUid, ')');
  console.log('XSRF-TOKEN:', xsrf.substring(0, 20) + '...');
  console.log('========================================\n');

  let totalPass = 0;
  let totalFail = 0;

  // ─── 测试1: Cookie 有效性 ───
  console.log('─'.repeat(40));
  console.log('测试 1: Cookie 有效性 (profile/info)');
  console.log('─'.repeat(40));
  try {
    const url = `https://weibo.com/ajax/profile/info?uid=${weiboUid}`;
    console.log('  URL:', url);
    const resp = await fetch(url, { headers: headers(cookies) });
    const text = await resp.text();
    console.log('  状态:', resp.status);
    
    let data: any;
    try { data = JSON.parse(text); } catch { 
      console.log('  ❌ 返回非JSON:', text.substring(0, 200));
      totalFail++;
    }
    
    if (data?.ok === 1 && data.data?.user) {
      console.log(`  ✅ 登录用户: ${data.data.user.screen_name} (粉丝: ${data.data.user.followers_count})`);
      totalPass++;
    } else {
      console.log('  ❌', text.substring(0, 200));
      totalFail++;
    }
  } catch (e: any) {
    console.log('  ❌', e.message);
    totalFail++;
  }

  // ─── 测试2: 搜索帖子 ───
  console.log('\n' + '─'.repeat(40));
  console.log('测试 2: 搜索帖子 (side/search)');
  console.log('─'.repeat(40));

  const testKeywords = ['日常', '分享'];
  let anyPostFound = false;
  let savedPostId = '';

  for (const kw of testKeywords) {
    try {
      const searchUrl = `https://weibo.com/ajax/side/search?q=${encodeURIComponent(kw)}&page=1`;
      console.log(`  搜索 "${kw}":`);
      console.log(`    URL: ${searchUrl}`);
      
      const resp = await fetch(searchUrl, {
        headers: { ...headers(cookies), Referer: 'https://s.weibo.com/' },
      });
      const text = await resp.text();
      console.log(`    状态: ${resp.status}, 长度: ${text.length}`);
      
      let data: any;
      try { data = JSON.parse(text); } catch {
        console.log(`    ❌ 非JSON: ${text.substring(0, 150)}`);
        totalFail++;
        continue;
      }
      
      const users = data?.data?.users || [];
      let postCount = 0;
      for (const user of users) {
        if (user.status) postCount++;
      }
      console.log(`    找到 ${postCount} 个帖子 (users: ${users.length})`);
      
      if (postCount > 0) {
        anyPostFound = true;
        totalPass++;
        for (const user of users) {
          if (user.status) {
            const s = user.status;
            savedPostId = s.idstr || s.mid;
            console.log(`    → [${user.screen_name}] ${(s.text || '').substring(0, 60)}`);
            console.log(`    → 评论${s.comments_count || 0} 转发${s.reposts_count || 0} 赞${s.attitudes_count || 0}`);
            break;
          }
        }
      } else {
        console.log('    ⚠️ 未找到帖子');
        totalFail++;
      }
    } catch (e: any) {
      console.log(`    ❌`, e.message);
      totalFail++;
    }
  }

  // ─── 测试3: 获取评论 ───
  console.log('\n' + '─'.repeat(40));
  console.log('测试 3: 获取评论 (buildcomments)');
  console.log('─'.repeat(40));

  if (savedPostId) {
    try {
      const commentUrl = `https://weibo.com/ajax/comments/buildcomments?id=${savedPostId}&is_show_bulletin=2&is_mix=0&count=20`;
      console.log(`  帖子 ID: ${savedPostId}`);
      console.log(`  URL: ${commentUrl.substring(0, 100)}...`);

      const resp = await fetch(commentUrl, { headers: headers(cookies) });
      const text = await resp.text();

      let data: any;
      try { data = JSON.parse(text); } catch {
        console.log('  ❌ 非JSON:', text.substring(0, 200));
        totalFail++;
      }

      const comments = data?.data || [];
      const total = data?.total_number || 0;
      console.log(`  ✅ 获取到 ${comments.length} 条评论 (共 ${total} 条)`);
      if (comments.length > 0) {
        console.log(`    → [${comments[0].user?.screen_name || '?'}]: ${(comments[0].text_raw || '').substring(0, 50)}`);
      }
      totalPass++;
    } catch (e: any) {
      console.log('  ❌', e.message);
      totalFail++;
    }
  } else {
    console.log('  ⚠️ 跳过（搜索未找到帖子）');
    totalFail++;
  }

  // ─── 测试4: 评论发送连通性 ───
  console.log('\n' + '─'.repeat(40));
  console.log('测试 4: 评论发送连通性 (POST create)');
  console.log('─'.repeat(40));
  
  try {
    const testResp = await fetch(`https://weibo.com/ajax/statuses/show?id=${weiboUid}`, {
      headers: headers(cookies),
    });
    console.log(`  statuses/show 状态: ${testResp.status}`);
    if (testResp.status === 200) {
      const text = await testResp.text();
      console.log(`  ✅ POST 接口 Cookie 验证通过 (${text.length} bytes)`);
      totalPass++;
    } else {
      console.log('  ❌ POST 接口异常');
      totalFail++;
    }
  } catch (e: any) {
    console.log('  ❌', e.message);
    totalFail++;
  }

  // ─── 汇总 ───
  console.log('\n' + '='.repeat(40));
  console.log(`测试完成: ${totalPass} 通过 / ${totalPass + totalFail} 总计`);
  if (totalFail === 0) {
    console.log('✅ 所有接口正常，账号可正常采集数据和评论');
  } else {
    console.log('⚠️ 部分接口异常，请检查上述日志');
  }
  console.log('='.repeat(40));

  await closeDb();
}

run().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
