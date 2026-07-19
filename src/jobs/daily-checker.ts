/**
 * 正式实验 - 每日 3:00 Cookie 有效性巡检
 * ============================================================================
 * 每天凌晨 3 点对所有 active 账号做一次轻量 cookie 检测：
 *   1. 用账号 cookie 请求 https://weibo.com/
 *   2. 被重定向到 login.sina.com.cn → cookie 已过期 → status='expired'
 *   3. 正常返回 → cookie 有效 → 更新 cookie_checked_at
 *   4. 结果写回 accounts（status / cookie_checked_at）
 * 前端账号页面根据 status 显示过期状态，提示重新扫码。
 *
 * 直跑调试：npx tsx src/jobs/daily-checker.ts
 */

import { updateOne } from '../lib/db';
import {
  Account,
  PC_UA,
  sleep,
  ts,
  now,
  getActiveAccounts,
} from './shared';

/** 检测单个账号 cookie 是否有效 */
async function checkAccountCookie(acc: Account): Promise<{ valid: boolean }> {
  try {
    const resp = await fetch('https://weibo.com/', {
      headers: {
        'User-Agent': PC_UA,
        Cookie: acc.cookie,
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });

    // 被 SSO 重定向到登录页 = cookie 过期
    if (resp.url.includes('login.sina.com.cn') || resp.url.includes('passport.weibo.com')) {
      return { valid: false };
    }
    return { valid: true };
  } catch {
    // 网络错误保守视为有效（不误杀）
    return { valid: true };
  }
}

export async function runDailyCookieCheck(): Promise<{ checked: number; expired: number }> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[每日Cookie巡检] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const accounts = await getActiveAccounts();
  console.log(`待检测 active 账号: ${accounts.length}`);

  let checked = 0;
  let expired = 0;
  for (const acc of accounts) {
    const { valid } = await checkAccountCookie(acc);
    const status = valid ? 'active' : 'expired';
    await updateOne('accounts', { id: acc.id }, {
      status,
      cookie_checked_at: now(),
    });
    checked++;
    if (!valid) expired++;
    const tag = valid ? '✅ 有效' : '⚠️ 过期';
    console.log(`  [${acc.nickname}] ${tag} → status=${status}`);
    // 请求间错峰，避免被风控
    await sleep(2000 + Math.random() * 2000);
  }

  console.log(`\n✅ 巡检完成: 共 ${checked} 个，过期 ${expired} 个，有效 ${checked - expired} 个`);
  return { checked, expired };
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/daily-checker.ts')) {
  runDailyCookieCheck()
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('巡检异常:', e);
      process.exit(1);
    });
}
