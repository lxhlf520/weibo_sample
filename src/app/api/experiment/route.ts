import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { query, maybeOne, insert, updateOne } from '@/lib/db';
import { randomizeAndGroup, assignTemplates } from '@/lib/experiment-engine';

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const { searchParams } = new URL(request.url);
    const experimentId = searchParams.get('id');
    if (experimentId) {
      const exp = await maybeOne(
        'experiment_runs',
        { id: experimentId, user_id: auth.id },
      );
      if (!exp) return NextResponse.json({ error: '实验不存在' }, { status: 404 });
      const { rows: posts } = await query(
        'posts',
        { experiment_id: experimentId, user_id: auth.id },
      );
      const { rows: logs } = await query(
        'intervention_logs',
        { experiment_id: experimentId },
      );
      return NextResponse.json({ experiment: exp, posts, interventionLogs: logs });
    }
    const { rows } = await query(
      'experiment_runs',
      { user_id: auth.id },
      { sort: { created_at: -1 } },
    );
    return NextResponse.json({ experiments: rows });
  } catch (err) {
    return NextResponse.json({ error: `获取实验列表失败: ${err}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'create') {
      const { posts, date } = body;
      if (!posts || !Array.isArray(posts) || posts.length < 3)
        return NextResponse.json({ error: '帖子数量不足' }, { status: 400 });

      const { grouped, config } = randomizeAndGroup(posts, 90);
      const withTemplates = await assignTemplates(grouped);
      const experimentDate = date || new Date().toISOString().split('T')[0];

      const exp = await insert('experiment_runs', {
        user_id: auth.id, date: experimentDate, status: 'screening', total_posts: config.totalPosts,
      });
      if (!exp) return NextResponse.json({ error: '创建实验失败' }, { status: 500 });
      const experimentId = exp.id;

      for (const item of withTemplates) {
        const post = await insert('posts', {
          user_id: auth.id, experiment_id: experimentId,
          mid: item.post.postId, post_url: item.post.postUrl, content: item.post.content,
          author_uid: item.post.authorUid, author_name: item.post.authorName, followers: item.post.followers,
          comments_count: item.post.commentsCount, reposts_count: item.post.repostsCount,
          likes_count: item.post.likesCount, post_group: item.group,
          pseudo_time: item.pseudoTime || null, published_at: item.post.publishedAt,
        });

        if (post) {
          await insert('intervention_logs', {
            experiment_id: experimentId, post_id: post.id,
            post_url: item.post.postUrl,
            post_group: item.group, comment_template: item.templateId ? String(item.templateId) : null,
            comment_content: item.commentContent, status: 'pending',
          });
        }
      }

      return NextResponse.json({
        success: true, experimentId, config,
        groups: {
          control: withTemplates.filter(g => g.group === 'control').length,
          low: withTemplates.filter(g => g.group === 'low').length,
          high: withTemplates.filter(g => g.group === 'high').length,
        },
      });
    }

    if (action === 'update_status') {
      const { experimentId, status } = body;
      await updateOne(
        'experiment_runs',
        { id: experimentId, user_id: auth.id },
        { status, updated_at: new Date().toISOString() },
      );
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: '无效action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: `请求处理失败: ${err}` }, { status: 500 });
  }
}
