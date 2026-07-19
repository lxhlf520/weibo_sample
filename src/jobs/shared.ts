/**
 * 正式实验定时调度系统 - 共享常量/类型/工具函数
 * ============================================================================
 * 被 collector.ts / commenter.ts / monitor.ts / scheduler.ts 复用
 */

// ─── 类型定义 ──────────────────────────────────────────────

export interface Account {
  id: string;
  nickname: string;
  weibo_uid: string;
  cookie: string;
  daily_comment_count: number;
  max_daily_comments: number;
  status: string;
  can_comment?: boolean; // 评论权限（风控禁评为 false，不影响采集）
  comment_checked_at?: string;
  comment_ban_reason?: string;
}

export interface ScreeningPost {
  postId: string;
  postUrl: string;
  content: string;
  authorUid: string;
  authorName: string;
  followers: number;
  commentsCount: number;
  repostsCount: number;
  likesCount: number;
  publishedAt: string;
}

export interface ExperimentRun {
  id: string;
  user_id: string;
  date: string;
  experiment_date: string;
  status: string; // screening | ready | running | completed
  total_posts: number;
  t0_at?: string;
  completed_points?: string[];
}

// ─── 规模参数（正式实验）──────────────────────────────────

// ─── 规模参数（分批增量建池）──────────────────────────────
// 支持环境变量覆盖（试跑用小规模），默认为正式实验规格。
// 策略：16/18/20 三批，每批采 CANDIDATE_BATCH 条候选追加池，跨批筛选累计；
//       合格帖累计 ≥ TARGET_QUALIFIED 即停后续批次；从池中选 EXPERIMENT_POSTS 做实验。
export const CANDIDATE_BATCH = Number(process.env.CANDIDATE_BATCH) || 2000; // 每批候选 mid 数
export const MAX_BATCHES = Number(process.env.MAX_BATCHES) || 3; // 最多采集批次（16/18/20）
export const TARGET_QUALIFIED = Number(process.env.TARGET_QUALIFIED) || 150; // 合格帖目标数（跨批累计）
export const EXPERIMENT_POSTS = Number(process.env.EXPERIMENT_POSTS) || 90; // 实验帖（三等分 control/low/high）
export const MAX_PAGES_PER_KEYWORD = Number(process.env.MAX_PAGES) || 8; // 每关键词最多翻页数
export const COLLECT_HOURS = [16, 18, 20]; // 采集批次触发的整点（每 2 小时一批）

// ─── 监控时间点 ────────────────────────────────────────────
// t0 单独在评论前采集，此处为 t0 之后的定时监控点
export const MONITOR_POINTS = ['t2h', 't4h', 't8h', 't12h', 't24h', 't48h', 't72h'] as const;
export type MonitorPoint = (typeof MONITOR_POINTS)[number];

/** 各监控点相对 t0 的偏移（小时） */
export const POINT_OFFSET_HOURS: Record<string, number> = {
  t2h: 2, t4h: 4, t8h: 8, t12h: 12, t24h: 24, t48h: 48, t72h: 72,
};

/** 实验生命周期终点（小时），超过即可标记 completed */
export const LIFECYCLE_HOURS = 72;

// ─── 搜索关键词（生活日常类，避开营销）────────────────────

export const SEARCH_KEYWORDS = [
  '日常', '分享', '生活', '美食', '旅行', '今天', '感觉', '真的', '最近', '突然',
  '开心', '好吃', '好看', '回家', '周末', '早安', '晚安', '天气', '心情', '工作',
  '下班', '加班', '奶茶', '咖啡', '电影', '追剧', '运动', '健身', '散步', '拍照',
  '风景', '日落', '早餐', '午餐', '晚餐', '宠物', '猫咪', '狗狗', '读书', '音乐',
];

// ─── 关键词黑名单（敏感/营销/引流/医疗法律）──────────────

export const EXCLUDE_KW = [
  // 敏感/政治
  '热搜', '政治', '灾难', '事故', '自杀', '自伤', '未成年人',
  // 营销/广告
  '抽奖', '转发抽奖', '福利', '加群', '广告', '推广', '优惠', '促销',
  '秒杀', '拼团', '红包', '赚钱', '兼职', '日赚', '投资', '理财',
  '股票', '基金', '保险', '代购', '微商', '加盟', '招商',
  // 涨粉/引流
  '私信我', '关注我', '求关注', '互粉', '涨粉', '求赞', '互赞',
  '课程', '训练营', '领取', '免费领', '限时',
  // 医疗/法律
  '医疗', '法律咨询', '金融',
];

// ─── 评论权限探测用中性短语（探测后会立即删除）────
export const PROBE_COMMENTS = ['记录一下', '打卡', '日常mark', '收到', '先做个标记'];

// ─── 通用工具函数 ──────────────────────────────────────────

const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function getXsrf(cookies: string): string {
  const m = cookies.match(/XSRF-TOKEN=([^;]+)/);
  return m ? m[1] : '';
}

export function buildHeaders(cookies: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': PC_UA,
    Cookie: cookies,
    'X-XSRF-TOKEN': getXsrf(cookies),
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://weibo.com/',
    Accept: 'application/json',
    ...extra,
  };
}

export function now(): string {
  return new Date().toISOString();
}

export function ts(): string {
  return new Date().toLocaleString();
}

// ─── s.weibo.com/realtime 网页抓取 mid ─────────────────────

/** 已告警过 cookie 过期的账号消重 */
const warnedExpired = new Set<string>();

export async function scrapeRealtimeMids(cookie: string, keyword: string, page: number = 1): Promise<string[]> {
  const url = `https://s.weibo.com/realtime?q=${encodeURIComponent(keyword)}&page=${page}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': PC_UA,
      Cookie: cookie,
      Referer: 'https://s.weibo.com/',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!resp.ok) return [];
  const html = await resp.text();

  // cookie 过期检测：被重定向到 SSO 登录页
  const isLoginPage = resp.url.includes('login.sina.com.cn');
  if (isLoginPage && page === 1) {
    const cookieId = cookie.substring(0, 60);
    if (!warnedExpired.has(cookieId)) {
      warnedExpired.add(cookieId);
      console.log(`⚠️ Cookie 过期: 请求被重定向到登录页 (keyword=${keyword})，请刷新该账号 cookie`);
    }
    return [];
  }

  // 正则提取 mid
  const mids = [...html.matchAll(/mid="(\d+)"/g)].map((m) => m[1]);
  // 调试：首次抓不到时输出 HTML 片段，帮助定位页面结构变化
  if (mids.length === 0 && page === 1) {
    console.log(`  [调试] realtime?q=${keyword} 状态=${resp.status} HTML长度=${html.length} URL=${resp.url.substring(0,80)}`);
    const cardIdx = html.indexOf('card-wrap');
    if (cardIdx >= 0) {
      console.log(`  [调试] 找到 card-wrap 但 mid regex 未命中，HTML片段: ${html.substring(cardIdx, cardIdx + 300).replace(/\s+/g, ' ')}`);
    } else {
      console.log(`  [调试] 未找到 card-wrap，HTML前300: ${html.substring(0, 300).replace(/\s+/g, ' ')}`);
    }
  }
  return mids;
}

// ─── statuses/show 获取帖子原始数据 ────────────────────────

export async function fetchStatusRaw(cookie: string, mid: string): Promise<any | null> {
  try {
    const resp = await fetch(`https://weibo.com/ajax/statuses/show?id=${mid}`, {
      headers: buildHeaders(cookie),
    });
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch {
      return null; // 返回 HTML（400/风控）时视为失败
    }
  } catch {
    return null;
  }
}

/**
 * 对单条 statuses/show 原始数据执行硬性筛选。
 * 通过返回 ScreeningPost，不通过返回 null。
 * 规则：12h 内、原创、非官方号(verified_type<=0)、≥8汉字、
 *      评论 10-500、粉丝<50万、无黑名单关键词。
 */
export function screenStatus(md: any, mid: string, cutoffMs: number): ScreeningPost | null {
  if (!md || md.ok === 0) return null;

  const content: string = md.text_raw || md.text || '';
  const postTime = new Date(md.created_at || '').getTime();
  const cc = md.comments_count || 0;
  const rp = md.reposts_count || 0;
  const lk = md.attitudes_count || 0;
  const followers = md.user?.followers_count || 0;
  const vt = md.user?.verified_type ?? -1;
  const ret = !!md.retweeted_status;
  const hanzi = (content.match(/[\u4e00-\u9fff]/g) || []).length;
  const authorUid = String(md.user?.id || '');
  const authorName = md.user?.screen_name || '';

  if (!postTime || postTime < cutoffMs) return null;
  if (ret) return null;
  if (vt > 0) return null; // 排除所有官方认证号
  if (hanzi < 8) return null;
  if (cc < 10 || cc > 500) return null;
  if (followers >= 500_000) return null;
  if (EXCLUDE_KW.some((kw) => content.toLowerCase().includes(kw.toLowerCase()))) return null;

  return {
    postId: mid,
    postUrl: `https://weibo.com/${authorUid}/${mid}`,
    content,
    authorUid,
    authorName,
    followers,
    commentsCount: cc,
    repostsCount: rp,
    likesCount: lk,
    publishedAt: md.created_at,
  };
}

// ─── 评论发送（单条，带 text() 容错解析）───────────────────

export async function sendOneComment(
  postId: string,
  content: string,
  cookie: string,
): Promise<{ ok: boolean; cid?: string; err?: string }> {
  try {
    const xsrf = getXsrf(cookie);
    const fd = new URLSearchParams({ id: postId, comment: content, mid: postId, st: xsrf });
    const resp = await fetch('https://weibo.com/ajax/comments/create', {
      method: 'POST',
      headers: { ...buildHeaders(cookie), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fd.toString(),
    });
    const text = await resp.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, err: text.substring(0, 100) };
    }
    if (data.ok === 1 && data.data) {
      const cid = data.data.idstr || data.data.comment?.idstr || String(data.data.id);
      return { ok: true, cid };
    }
    return { ok: false, err: data.msg || data.error || `retcode:${data.ok}` };
  } catch (e: any) {
    return { ok: false, err: e.message };
  }
}

// ─── 获取账号自己最近一条微博 mid（用于评论权限探测）──
export async function fetchOwnLatestMid(cookie: string, uid: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://weibo.com/ajax/statuses/mymblog?uid=${uid}&page=1&feature=0`, {
      headers: buildHeaders(cookie),
    });
    const text = await resp.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    const list: any[] = data?.data?.list || [];
    for (const p of list) {
      const mid = p.mid || p.idstr || (p.id ? String(p.id) : '');
      if (mid) return String(mid);
    }
    return null;
  } catch {
    return null;
  }
}

// ─── 删除一条评论（探测后清理痕迹）──────────
export async function deleteComment(cookie: string, mid: string, cid: string): Promise<boolean> {
  try {
    const xsrf = getXsrf(cookie);
    const fd = new URLSearchParams({ mid, cid, st: xsrf });
    const resp = await fetch('https://weibo.com/ajax/comments/destroy', {
      method: 'POST',
      headers: { ...buildHeaders(cookie), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fd.toString(),
    });
    const text = await resp.text();
    try {
      return JSON.parse(text).ok === 1;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

// ─── 账号读取 ──────────────────────────────────────────────

import { query } from '../lib/db';

/** 读取所有 active 账号 */
export async function getActiveAccounts(): Promise<Account[]> {
  const { rows } = await query<Account>('accounts', { status: 'active' });
  return rows;
}

/** 读取可评论账号：status=active 且 未被标记禁评（can_comment !== false） */
export async function getCommentableAccounts(): Promise<Account[]> {
  const { rows } = await query<Account>('accounts', {
    status: 'active',
    can_comment: { $ne: false },
  });
  return rows;
}
