/**
 * 按账号测试采集 API
 * POST /api/accounts/test-collect
 * Body: { accountId }
 * 使用指定账号搜索一个关键词，返回采集+筛选结果
 */
import { NextRequest, NextResponse } from 'next/server';
import { maybeOne } from '@/lib/db';

interface Account {
  id: string;
  nickname: string;
  weibo_uid: string;
  cookie: string;
  status: string;
}

export async function POST(request: NextRequest) {
  const results: string[] = [];
  const startTime = Date.now();

  try {
    const { accountId } = await request.json();
    if (!accountId) return NextResponse.json({ success: false, error: '缺少 accountId' }, { status: 400 });

    const acc = await maybeOne<Account>('accounts', { id: accountId });
    if (!acc) return NextResponse.json({ success: false, error: `账号 ${accountId} 不存在` }, { status: 404 });
    if (acc.status !== 'active') return NextResponse.json({ success: false, error: `账号 "${acc.nickname}" 状态为 ${acc.status}，非 active` });
    if (!acc.cookie) return NextResponse.json({ success: false, error: `账号 "${acc.nickname}" 无 Cookie` });

    results.push(`使用账号: ${acc.nickname} (uid=${acc.weibo_uid})`);

    const { scrapeRealtimeMids, fetchStatusRaw, screenStatus } = await import('@/jobs/shared');
    const keyword = '日常';
    results.push(`搜索关键词: "${keyword}"`);

    const mids = await scrapeRealtimeMids(acc.cookie, keyword, 1);
    results.push(`搜索到 ${mids.length} 条 mid`);

    if (mids.length === 0) {
      results.push('⚠️ 搜索结果为空，可能 cookie 过期或页面结构变化');
      return NextResponse.json({
        success: true, account: acc.nickname, keyword,
        midsFound: 0, postsScreened: 0, postsPassed: 0,
        elapsed: Date.now() - startTime, log: results,
      });
    }

    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    let screened = 0, passed = 0;
    const maxTest = Math.min(3, mids.length);

    for (let i = 0; i < maxTest; i++) {
      const mid = mids[i];
      const md = await fetchStatusRaw(acc.cookie, mid);
      screened++;
      if (md) {
        const sp = screenStatus(md, mid, cutoff);
        if (sp) {
          passed++;
          results.push(`  ✅ ${mid} 通过: @${sp.authorName} 评论${sp.commentsCount} 粉丝${sp.followers}`);
        } else {
          results.push(`  ❌ ${mid} 未通过筛选`);
        }
      } else {
        results.push(`  ⚠️ ${mid} fetchStatusRaw 返回空`);
      }
    }

    return NextResponse.json({
      success: true, account: acc.nickname, keyword,
      midsFound: mids.length, postsScreened: screened, postsPassed: passed,
      elapsed: Date.now() - startTime, log: results,
    });
  } catch (e: any) {
    results.push(`异常: ${e.message}`);
    return NextResponse.json({ success: false, error: e.message, elapsed: Date.now() - startTime, log: results }, { status: 500 });
  }
}
