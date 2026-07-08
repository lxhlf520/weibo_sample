import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { query, insert } from '@/lib/db';
import { screenPosts, ScreenedPost } from '@/lib/post-screener';

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const { searchParams } = new URL(request.url);
    const experimentId = searchParams.get('experimentId');
    let filter: Record<string, unknown> = { user_id: auth.id };
    if (experimentId) filter.experiment_id = experimentId;
    const { rows } = await query('posts', filter, { sort: { screened_at: -1 } });
    return NextResponse.json({ posts: rows });
  } catch (err) {
    return NextResponse.json({ error: `获取帖子列表失败: ${err}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const body = await request.json();
    const { action, cookies, keywords, criteria } = body;

    if (action === 'screen') {
      if (!cookies) return NextResponse.json({ error: '缺少微博Cookie' }, { status: 400 });
      if (!keywords || !Array.isArray(keywords) || keywords.length === 0)
        return NextResponse.json({ error: '缺少搜索关键词' }, { status: 400 });

      const result = await screenPosts(cookies, keywords, criteria || {});
      return NextResponse.json({
        success: true, passed: result.passed, rejected: result.rejected,
        stats: { passedCount: result.passed.length, rejectedCount: result.rejected.length },
      });
    }

    if (action === 'save') {
      const { experimentId, posts } = body;
      if (!experimentId || !posts || !Array.isArray(posts))
        return NextResponse.json({ error: '缺少实验ID或帖子数据' }, { status: 400 });

      const saved: string[] = [];
      for (const post of posts as ScreenedPost[]) {
        const row = await insert('posts', {
          user_id: auth.id, experiment_id: experimentId,
          post_id: post.postId, post_url: post.postUrl, content: post.content,
          author_uid: post.authorUid, author_name: post.authorName, followers: post.followers,
          comments_count: post.commentsCount, reposts_count: post.repostsCount,
          likes_count: post.likesCount, published_at: post.publishedAt,
        });
        if (row) saved.push(row.id as string);
      }
      return NextResponse.json({ success: true, savedCount: saved.length, ids: saved });
    }

    return NextResponse.json({ error: '无效action: screen / save' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: `请求处理失败: ${err}` }, { status: 500 });
  }
}
