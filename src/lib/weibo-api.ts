/**
 * 微博数据采集与评论API
 * 基于 weibo.com/ajax/ 接口，需要有效的PC端Cookie
 */

const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface WeiboPost {
  id: string;
  idstr: string;
  created_at: string;
  text_raw: string;
  text: string;
  user: {
    id: number;
    idstr: string;
    screen_name: string;
    description?: string;
    followers_count: number;
    verified: boolean;
    verified_type: number;
    avatar_hd: string;
  };
  retweeted_status?: unknown;
  reposts_count: number;
  comments_count: number;
  attitudes_count: number;
  isLongText: boolean;
}

export interface WeiboComment {
  id: number;
  idstr: string;
  created_at: string;
  text: string;
  text_raw: string;
  user: {
    id: number;
    idstr: string;
    screen_name: string;
    avatar_hd: string;
  };
  like_counts: number;
  reply_comment?: {
    id: string;
    text: string;
  };
  rootid?: string;
  rootidstr?: string;
}

/**
 * 从Cookie中提取XSRF-TOKEN
 */
function getXsrfToken(cookies: string): string {
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  return match ? match[1] : '';
}

/**
 * 通用请求头
 */
function headers(cookies: string): Record<string, string> {
  const xsrf = getXsrfToken(cookies);
  return {
    'User-Agent': PC_UA,
    'Cookie': cookies,
    'X-XSRF-TOKEN': xsrf,
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://weibo.com/',
    'Accept': 'application/json, text/plain, */*',
  };
}

/**
 * 搜索微博帖子
 * 使用微博搜索接口
 */
export async function searchPosts(
  cookies: string,
  keyword: string,
  page: number = 1,
): Promise<{ posts: WeiboPost[]; total: number }> {
  const params = new URLSearchParams({
    q: keyword,
    page: String(page),
  });

  const resp = await fetch(`https://weibo.com/ajax/side/search?${params.toString()}`, {
    headers: {
      ...headers(cookies),
      Referer: 'https://s.weibo.com/',
    },
  });

  if (!resp.ok) {
    throw new Error(`搜索帖子失败: HTTP ${resp.status}`);
  }

  const data = await resp.json();

  // API 返回 data.users[]，每个 user 的 status 字段是最近的帖子
  const users = data?.data?.users || [];
  const posts: WeiboPost[] = [];

  for (const user of users) {
    if (user.status) {
      // 把用户信息合并到 post 里
      const post = user.status;
      if (!post.user) {
        post.user = {
          id: user.id,
          idstr: user.idstr,
          screen_name: user.screen_name,
          followers_count: user.followers_count || 0,
          verified: user.verified || false,
          verified_type: user.verified_type || 0,
          avatar_hd: user.avatar_hd || user.profile_image_url || '',
        };
      }
      posts.push(post);
    }
  }

  return { posts, total: posts.length };
}

/**
 * 获取微博帖子详情
 */
export async function getPostDetail(cookies: string, postId: string): Promise<WeiboPost | null> {
  const resp = await fetch(`https://weibo.com/ajax/statuses/extend?id=${postId}`, {
    headers: headers(cookies),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  return data?.data || data || null;
}

/**
 * 获取帖子详情（同时获取转赞评数据）
 */
export async function getPostMetrics(
  cookies: string,
  postId: string,
): Promise<{ comments: number; reposts: number; likes: number } | null> {
  const resp = await fetch(`https://weibo.com/ajax/statuses/show?id=${postId}`, {
    headers: headers(cookies),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  if (!data) return null;

  return {
    comments: data.comments_count || 0,
    reposts: data.reposts_count || 0,
    likes: data.attitudes_count || 0,
  };
}

/**
 * 获取帖子评论列表
 */
export async function getComments(
  cookies: string,
  postId: string,
  page: number = 1,
  maxId?: string,
): Promise<{ comments: WeiboComment[]; max_id: string | null; total: number }> {
  const params = new URLSearchParams({
    id: postId,
    is_show_bulletin: '2',
    is_mix: '0',
    count: '20',
  });
  if (maxId) params.set('max_id', maxId);

  const resp = await fetch(
    `https://weibo.com/ajax/comments/buildcomments?${params.toString()}`,
    { headers: headers(cookies) },
  );

  if (!resp.ok) {
    throw new Error(`获取评论失败: HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const comments: WeiboComment[] = data?.data || [];
  const max_id = data?.max_id || null;
  const total = data?.total_number || 0;

  return { comments, max_id, total };
}

/**
 * 获取全部评论（自动翻页）
 */
export async function getAllComments(
  cookies: string,
  postId: string,
  maxPages: number = 10,
): Promise<WeiboComment[]> {
  const allComments: WeiboComment[] = [];
  let maxId: string | undefined;
  let page = 0;

  while (page < maxPages) {
    const result = await getComments(cookies, postId, page + 1, maxId);
    allComments.push(...result.comments);

    if (!result.max_id) break;
    maxId = result.max_id;
    page++;
  }

  return allComments;
}

/**
 * 发表一级评论
 * @returns { success: boolean, commentId?: string }
 */
export async function postComment(
  cookies: string,
  postId: string,
  content: string,
): Promise<{ success: boolean; commentId?: string; error?: string }> {
  try {
    const xsrf = getXsrfToken(cookies);
    const formData = new URLSearchParams();
    formData.append('id', postId);
    formData.append('comment', content);
    formData.append('mid', postId);
    formData.append('st', xsrf);

    const resp = await fetch('https://weibo.com/ajax/comments/create', {
      method: 'POST',
      headers: {
        ...headers(cookies),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    const data = await resp.json();

    if (data.ok === 1 && data.data) {
      return {
        success: true,
        commentId: data.data.idstr || data.data.comment?.idstr || String(data.data.id),
      };
    }

    const errMsg = data.msg || data.error || `评论发送失败 (retcode: ${data.ok})`;
    return { success: false, error: errMsg };
  } catch (err) {
    return { success: false, error: `网络错误: ${String(err)}` };
  }
}

/**
 * 获取用户信息
 */
export async function getUserProfile(
  cookies: string,
  uid: string,
): Promise<{ nickname: string; avatar: string; followers: number } | null> {
  const resp = await fetch(`https://weibo.com/ajax/profile/info?uid=${uid}`, {
    headers: headers(cookies),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  if (data.ok !== 1 || !data.data?.user) return null;

  const user = data.data.user;
  return {
    nickname: user.screen_name || '',
    avatar: user.avatar_hd || user.profile_image_url || '',
    followers: user.followers_count || 0,
  };
}

/**
 * 获取博主微博列表
 */
export async function getUserPosts(
  cookies: string,
  uid: string,
  page: number = 1,
): Promise<WeiboPost[]> {
  const resp = await fetch(
    `https://weibo.com/ajax/statuses/mymblog?uid=${uid}&page=${page}&feature=0`,
    { headers: headers(cookies) },
  );

  if (!resp.ok) return [];

  const data = await resp.json();
  return data?.data?.list || data?.data || [];
}

/**
 * 批量获取帖子指标（用于定时数据采集）
 */
export async function batchGetPostMetrics(
  cookies: string,
  postIds: string[],
): Promise<Map<string, { comments: number; reposts: number; likes: number }>> {
  const result = new Map<string, { comments: number; reposts: number; likes: number }>();

  // 逐个请求，避免触发风控
  for (const postId of postIds) {
    try {
      const metrics = await getPostMetrics(cookies, postId);
      if (metrics) {
        result.set(postId, metrics);
      }
      // 请求间隔
      await sleep(500 + Math.random() * 1000);
    } catch {
      // 单个失败不影响整体
    }
  }

  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
