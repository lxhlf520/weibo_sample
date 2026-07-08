/**
 * 测试发送微博评论
 * 运行：pnpm exec tsx test-comment.ts
 */
import { query, closeDb } from './src/lib/db';

async function run() {
  const { rows } = await query(
    'weibo_accounts',
    { status: 'active' },
    { sort: { updated_at: -1 }, limit: 1 },
  );
  if (!rows.length) { console.log('❌ 没有活跃账号'); await closeDb(); return; }

  const cookies: string = (rows[0] as any).cookie;
  const xsrf = cookies.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '';
  console.log('XSRF-TOKEN:', xsrf.substring(0, 20) + '...');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Cookie: cookies,
    'X-XSRF-TOKEN': xsrf,
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json, text/plain, */*',
  };

  // 1. 搜索帖子
  console.log('\n1. 搜索帖子...');
  const sResp = await fetch('https://weibo.com/ajax/side/search?q=%E5%88%86%E4%BA%AB', {
    headers: { ...headers, Referer: 'https://s.weibo.com/' },
  });
  const sData: any = await sResp.json();
  const users = sData?.data?.users || [];

  let postId = '';
  for (const u of users) {
    if (u.status?.idstr) {
      postId = u.status.idstr;
      console.log(`   找到帖子: ${postId} @${u.screen_name}`);
      break;
    }
  }
  if (!postId) { console.log('   ❌ 没找到帖子'); await closeDb(); return; }

  // 2. 发送评论
  const comment = '今天天气真好。';
  console.log(`\n2. 发送评论: "${comment}"`);

  const formData = new URLSearchParams();
  formData.append('id', postId);
  formData.append('comment', comment);
  formData.append('mid', postId);
  formData.append('st', xsrf);

  const resp = await fetch('https://weibo.com/ajax/comments/create', {
    method: 'POST',
    headers: { ...headers, Referer: 'https://weibo.com/', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString(),
  });
  const text = await resp.text();
  console.log('   HTTP', resp.status);
  console.log('   响应:', text.substring(0, 300));

  let data: any;
  try { data = JSON.parse(text); } catch { console.log('   ❌ 非JSON响应'); await closeDb(); return; }

  if (data.ok === 1) {
    console.log('   ✅ 评论发送成功!');
    console.log('   commentId:', data.data?.idstr || data.data?.comment?.idstr || 'N/A');
  } else {
    console.log('   ❌ 失败:', data.msg || data.error || JSON.stringify(data));
  }

  await closeDb();
}

run().catch((e) => { console.error('异常:', e); process.exit(1); });
