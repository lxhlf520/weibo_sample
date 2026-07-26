/**
 * 测试评论 API
 * POST /api/test/comment
 * 使用一个可评论账号发一条测试评论，然后立即删除，验证评论链路是否正常
 */
import { NextResponse } from 'next/server';

export async function POST() {
  const results: string[] = [];
  const startTime = Date.now();

  try {
    const { getCommentableAccounts, fetchOwnLatestMid, sendOneComment, deleteComment } =
      await import('@/jobs/shared');

    const accounts = await getCommentableAccounts();
    if (accounts.length === 0) {
      return NextResponse.json({ success: false, error: '没有可评论账号（请先运行评论权限检测）' });
    }

    const acc = accounts[0];
    results.push(`使用账号: ${acc.nickname} (uid=${acc.weibo_uid})`);

    // 获取账号自己的一条微博
    const mid = await fetchOwnLatestMid(acc.cookie, acc.weibo_uid);
    if (!mid) {
      return NextResponse.json({
        success: false,
        error: '该账号无自有微博可测试',
        account: acc.nickname,
        elapsed: Date.now() - startTime,
        log: results,
      });
    }
    results.push(`测试目标微博: ${mid}`);

    // 发送测试评论
    const testComment = `测试评论 ${Date.now() % 10000}`;
    results.push(`发送测试评论: "${testComment}"`);

    const r = await sendOneComment(mid, testComment, acc.cookie);
    if (!r.ok) {
      results.push(`❌ 评论失败: ${r.err}`);
      return NextResponse.json({
        success: false,
        error: r.err || '评论失败',
        account: acc.nickname,
        mid,
        elapsed: Date.now() - startTime,
        log: results,
      });
    }
    results.push(`✅ 评论成功 cid=${r.cid}`);

    // 立即删除测试评论
    if (r.cid) {
      const delOk = await deleteComment(acc.cookie, mid, r.cid);
      results.push(delOk ? '✅ 测试评论已删除' : '⚠️ 测试评论删除失败（不影响判定）');
    }

    return NextResponse.json({
      success: true,
      account: acc.nickname,
      mid,
      commentId: r.cid,
      deleted: true,
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
