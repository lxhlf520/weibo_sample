/**
 * 测试采集 API
 * POST /api/test/collect
 * 使用一个 active 账号搜索一个关键词，返回采集结果
 */
import { NextResponse } from 'next/server';

export async function POST() {
  const results: string[] = [];
  const startTime = Date.now();

  try {
    // 动态导入 jobs 模块（避免 Next.js 构建时加载 MongoDB）
    const { getActiveAccounts, scrapeRealtimeMids, fetchStatusRaw, screenStatus } =
      await import('@/jobs/shared');

    const accounts = await getActiveAccounts();
    if (accounts.length === 0) {
      return NextResponse.json({ success: false, error: '没有 active 账号' });
    }

    const acc = accounts[0];
    results.push(`使用账号: ${acc.nickname}`);

    // 测试搜索
    const keyword = '日常';
    results.push(`搜索关键词: "${keyword}"`);

    const mids = await scrapeRealtimeMids(acc.cookie, keyword, 1);
    results.push(`搜索到 ${mids.length} 条 mid`);

    if (mids.length === 0) {
      results.push('⚠️ 搜索结果为空，可能 cookie 过期或页面结构变化');
      return NextResponse.json({
        success: true,
        account: acc.nickname,
        keyword,
        midsFound: 0,
        postsScreened: 0,
        postsPassed: 0,
        elapsed: Date.now() - startTime,
        log: results,
      });
    }

    // 测试筛选前3条
    const cutoff = Date.now() - 12 * 60 * 60 * 1000; // 12小时内
    let screened = 0;
    let passed = 0;
    const maxTest = Math.min(3, mids.length);

    for (let i = 0; i < maxTest; i++) {
      const mid = mids[i];
      const md = await fetchStatusRaw(acc.cookie, mid);
      screened++;
      if (md) {
        const sp = screenStatus(md, mid, cutoff);
        if (sp) {
          passed++;
          results.push(`  ✅ ${mid} 通过筛选: @${sp.authorName} 评论${sp.commentsCount} 粉丝${sp.followers}`);
        } else {
          results.push(`  ❌ ${mid} 未通过筛选`);
        }
      } else {
        results.push(`  ⚠️ ${mid} fetchStatusRaw 返回空`);
      }
    }

    return NextResponse.json({
      success: true,
      account: acc.nickname,
      keyword,
      midsFound: mids.length,
      postsScreened: screened,
      postsPassed: passed,
      elapsed: Date.now() - startTime,
      log: results,
    });
  } catch (e: any) {
    results.push(`异常: ${e.message}`);
    return NextResponse.json({
      success: false,
      error: e.message,
      elapsed: Date.now() - startTime,
      log: results,
    }, { status: 500 });
  }
}
