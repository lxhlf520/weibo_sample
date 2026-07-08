import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { query, maybeOne, inc, updateOne } from '@/lib/db';
import { postComment } from '@/lib/weibo-api';

interface WbAccount { id: string; cookie: string; daily_comment_count: number; max_daily_comments: number; }
interface IntLog { id: string; post_id: string; comment_content: string; }
interface WbPost { id: string; post_id: string; }

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'send') {
      const { accountId, postId, content } = body;
      if (!accountId || !postId || !content)
        return NextResponse.json({ error: '缺少参数' }, { status: 400 });

      const account = await maybeOne<WbAccount>(
        'weibo_accounts',
        { id: accountId, user_id: auth.id },
      );
      if (!account) return NextResponse.json({ error: '账号不存在' }, { status: 404 });
      if (account.daily_comment_count >= account.max_daily_comments)
        return NextResponse.json({ error: '日配额已满' }, { status: 429 });

      const result = await postComment(account.cookie, postId, content);

      await inc('weibo_accounts', { id: accountId }, { daily_comment_count: 1 });
      await updateOne(
        'weibo_accounts',
        { id: accountId },
        { last_used_at: new Date().toISOString(), status: result.success ? 'active' : 'error' },
      );

      return NextResponse.json({ success: result.success, commentId: result.commentId, error: result.error });
    }

    if (action === 'batch_send') {
      const { experimentId } = body;
      if (!experimentId) return NextResponse.json({ error: '缺少实验ID' }, { status: 400 });

      const { rows: logs } = await query<IntLog>(
        'intervention_logs',
        { experiment_id: experimentId, status: 'pending', post_group: { $ne: 'control' } },
      );
      if (logs.length === 0) return NextResponse.json({ error: '没有待发送的评论' }, { status: 400 });

      const { rows: accounts } = await query<WbAccount>(
        'weibo_accounts',
        { user_id: auth.id, status: 'active' },
      );
      if (accounts.length === 0) return NextResponse.json({ error: '没有可用账号' }, { status: 400 });

      const postIds = logs.map(l => l.post_id);
      const uniqueIds = [...new Set(postIds)];
      const { rows: posts } = await query<WbPost>(
        'posts',
        { id: { $in: uniqueIds } },
      );
      const postMap = new Map(posts.map(p => [p.id, p]));

      const results: Array<{ logId: string; success: boolean; error?: string }> = [];
      let accIdx = 0;

      for (const log of logs) {
        const post = postMap.get(log.post_id);
        if (!post) { results.push({ logId: log.id, success: false, error: '帖子不存在' }); continue; }

        const acc = accounts[accIdx % accounts.length];
        accIdx++;
        if (acc.daily_comment_count >= acc.max_daily_comments) {
          results.push({ logId: log.id, success: false, error: '账号配额已满' }); continue;
        }

        const result = await postComment(acc.cookie, post.post_id, log.comment_content);

        await updateOne(
          'intervention_logs',
          { id: log.id },
          {
            status: result.success ? 'sent' : 'failed',
            sent_at: result.success ? new Date().toISOString() : null,
            weibo_comment_id: result.commentId || null,
            error_message: result.error || null,
            account_id: acc.id,
          },
        );

        await inc('weibo_accounts', { id: acc.id }, { daily_comment_count: 1 });
        await updateOne('weibo_accounts', { id: acc.id }, { last_used_at: new Date().toISOString() });
        acc.daily_comment_count++;
        results.push({ logId: log.id, success: result.success, error: result.error });
        await new Promise(r => setTimeout(r, 5000 + Math.random() * 10000));
      }

      return NextResponse.json({
        success: true,
        totalSent: results.filter(r => r.success).length,
        totalFailed: results.filter(r => !r.success).length,
        results,
      });
    }

    return NextResponse.json({ error: '无效action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: `请求失败: ${err}` }, { status: 500 });
  }
}
