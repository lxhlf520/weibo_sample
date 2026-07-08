import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { query, maybeOne, updateMany, upsert } from '@/lib/db';
import { batchGetPostMetrics, getAllComments } from '@/lib/weibo-api';

interface WbPost { id: string; post_id: string; post_group: string; }
interface Snapshot { comments: number; reposts: number; likes: number; }

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const { searchParams } = new URL(request.url);
    const experimentId = searchParams.get('experimentId');
    const type = searchParams.get('type') || 'snapshots';
    if (!experimentId) return NextResponse.json({ error: '缺少实验ID' }, { status: 400 });

    switch (type) {
      case 'snapshots': {
        const { rows: posts } = await query<WbPost>(
          'posts',
          { experiment_id: experimentId, user_id: auth.id },
        );
        if (!posts.length) return NextResponse.json({ snapshots: [], posts: [] });
        const { rows: snapshots } = await query(
          'post_snapshots',
          { post_id: { $in: posts.map(p => p.id) } },
          { sort: { collected_at: 1 } },
        );
        return NextResponse.json({ posts, snapshots });
      }
      case 'interventions': {
        const { rows: logs } = await query(
          'intervention_logs',
          { experiment_id: experimentId },
        );
        return NextResponse.json({ logs });
      }
      case 'outcome': {
        const { rows: outcome } = await query(
          'outcome_analysis',
          { experiment_id: experimentId },
        );
        return NextResponse.json({ outcome });
      }
      case 'comments': {
        const { rows: posts } = await query(
          'posts',
          { experiment_id: experimentId, user_id: auth.id },
        );
        if (!posts.length) return NextResponse.json({ comments: [] });
        const { rows: comments } = await query(
          'comment_snapshots',
          { post_id: { $in: posts.map(p => p.id) } },
          { sort: { comment_time: -1 } },
        );
        return NextResponse.json({ comments });
      }
      default:
        return NextResponse.json({ error: '未知数据类型' }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: `数据查询失败: ${err}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'collect_snapshot') {
      const { experimentId, timePoint, cookies } = body;
      if (!experimentId || !timePoint || !cookies)
        return NextResponse.json({ error: '缺少参数' }, { status: 400 });

      const validPoints = ['t0', 't2h', 't4h', 't8h', 't12h', 't24h', 't48h', 't72h'];
      if (!validPoints.includes(timePoint))
        return NextResponse.json({ error: '无效时间点' }, { status: 400 });

      const { rows: posts } = await query<WbPost>(
        'posts',
        { experiment_id: experimentId, user_id: auth.id },
      );
      if (!posts.length) return NextResponse.json({ error: '实验没有帖子' }, { status: 404 });

      const metricsMap = await batchGetPostMetrics(cookies, posts.map(p => p.post_id));
      let savedCount = 0;
      for (const post of posts) {
        const metrics = metricsMap.get(post.post_id);
        if (!metrics) continue;
        await upsert(
          'post_snapshots',
          { post_id: post.id, time_point: timePoint },
          { comments: metrics.comments, reposts: metrics.reposts, likes: metrics.likes, raw_metadata: JSON.stringify(metrics), collected_at: new Date().toISOString() },
        );
        savedCount++;
      }
      return NextResponse.json({ success: true, timePoint, savedSnapshots: savedCount, totalPosts: posts.length });
    }

    if (action === 'calculate_outcome') {
      const { experimentId } = body;
      if (!experimentId) return NextResponse.json({ error: '缺少实验ID' }, { status: 400 });

      const { rows: posts } = await query<WbPost>(
        'posts',
        { experiment_id: experimentId, user_id: auth.id },
      );
      let calculated = 0;
      for (const post of posts) {
        const t0 = await maybeOne<Snapshot>(
          'post_snapshots',
          { post_id: post.id, time_point: 't0' },
        ) || { comments: 0, reposts: 0, likes: 0 };
        const t72 = await maybeOne<Snapshot>(
          'post_snapshots',
          { post_id: post.id, time_point: 't72h' },
        ) || { comments: 0, reposts: 0, likes: 0 };

        await upsert(
          'outcome_analysis',
          { experiment_id: experimentId, post_id: post.id },
          {
            post_group: post.post_group,
            baseline_comments: t0.comments, baseline_reposts: t0.reposts, baseline_likes: t0.likes,
            final_comments: t72.comments, final_reposts: t72.reposts, final_likes: t72.likes,
            delta_comments: t72.comments - t0.comments, delta_reposts: t72.reposts - t0.reposts, delta_likes: t72.likes - t0.likes,
            calculated_at: new Date().toISOString(),
          },
        );
        calculated++;
      }
      return NextResponse.json({ success: true, calculatedPosts: calculated });
    }

    return NextResponse.json({ error: '无效action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: `请求处理失败: ${err}` }, { status: 500 });
  }
}
