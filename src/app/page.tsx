'use client';

import { useState, useEffect } from 'react';
import { useAuth } from './auth-context';
import { useRouter } from 'next/navigation';

interface ExperimentRun {
  id: string;
  experiment_date: string;
  status: string;
  qualified_count?: number;
}

interface WeiboAccount {
  id: string;
  status: string;
  daily_comment_count: number;
  max_daily_comments: number;
  can_comment?: boolean;
}

export default function HomePage() {
  const { isAuthenticated, login, userName, userId, token } = useAuth();
  const [tokenInput, setTokenInput] = useState('');
  const [newUserName, setNewUserName] = useState('');
  const [error, setError] = useState('');
  const [createMode, setCreateMode] = useState(false);
  const router = useRouter();

  // 仪表盘实时数据
  const [stats, setStats] = useState({ running: 0, total: 0, activeAccounts: 0, totalAccounts: 0, usedComments: 0, maxComments: 0, commentableAccounts: 0 });

  // 测试按钮状态
  const [testCollectResult, setTestCollectResult] = useState<{ loading: boolean; data?: any; error?: string }>({ loading: false });
  const [testCommentResult, setTestCommentResult] = useState<{ loading: boolean; data?: any; error?: string }>({ loading: false });
  useEffect(() => {
    if (!isAuthenticated) return;
    Promise.all([
      fetch('/api/experiment', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch('/api/accounts', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ]).then(([expData, accData]) => {
      const exps: ExperimentRun[] = expData.experiments || [];
      const accounts: WeiboAccount[] = accData.accounts || [];
      const active = accounts.filter(a => a.status === 'active');
      setStats({
        running: exps.filter(e => e.status === 'running').length,
        total: exps.length,
        activeAccounts: active.length,
        totalAccounts: accounts.length,
        usedComments: active.reduce((s, a) => s + (a.daily_comment_count || 0), 0),
        maxComments: active.reduce((s, a) => s + (a.max_daily_comments || 0), 0),
        commentableAccounts: active.filter(a => a.can_comment !== false).length,
      });
    }).catch(() => {});
  }, [isAuthenticated, token]);

  // 测试采集
  const handleTestCollect = async () => {
    setTestCollectResult({ loading: true });
    try {
      const resp = await fetch('/api/test/collect', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const data = await resp.json();
      setTestCollectResult({ loading: false, data });
    } catch (e: any) {
      setTestCollectResult({ loading: false, error: e.message });
    }
  };

  // 测试评论
  const handleTestComment = async () => {
    setTestCommentResult({ loading: true });
    try {
      const resp = await fetch('/api/test/comment', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const data = await resp.json();
      setTestCommentResult({ loading: false, data });
    } catch (e: any) {
      setTestCommentResult({ loading: false, error: e.message });
    }
  };

  // Token 登录
  const handleTokenLogin = async () => {
    setError('');
    if (!tokenInput.trim()) {
      setError('请输入Token');
      return;
    }
    const ok = await login(tokenInput.trim());
    if (!ok) {
      setError('Token无效，请检查后重试');
    }
  };

  // 创建新用户
  const handleCreateUser = async () => {
    setError('');
    if (!newUserName.trim() || newUserName.trim().length < 2) {
      setError('用户名至少2个字符');
      return;
    }

    const resp = await fetch('/api/auth/check', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newUserName.trim() }),
    });

    const data = await resp.json();
    if (data.success && data.user) {
      await login(data.user.token);
    } else {
      setError(data.error || '创建用户失败');
    }
  };

  if (!isAuthenticated) {
    // 登录页面
    return (
      <div className="flex items-center justify-center min-h-[80vh]">
        <div className="w-full max-w-md bg-white rounded-xl shadow-lg p-8">
          <h1 className="text-2xl font-bold text-center mb-2">微博AI评论互动实验平台</h1>
          <p className="text-gray-500 text-center mb-6 text-sm">社交媒体公开场域AI评论互动实验</p>

          {!createMode ? (
            <>
              <label className="block text-sm font-medium text-gray-700 mb-1">实验用户Token</label>
              <input
                type="text"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="请输入您的实验Token（离线模式：admin-dev-token-for-local-dashboard）"
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 mb-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                onKeyDown={(e) => e.key === 'Enter' && handleTokenLogin()}
              />
              {error && <p className="text-red-500 text-sm mb-3">{error}</p>}
              <button
                onClick={handleTokenLogin}
                className="w-full bg-blue-600 text-white rounded-lg py-2.5 font-medium hover:bg-blue-700 transition"
              >
                登录
              </button>
              <p className="text-center mt-4 text-sm text-gray-500">
                没有Token？
                <button
                  onClick={() => { setCreateMode(true); setError(''); }}
                  className="text-blue-600 hover:underline ml-1"
                >
                  创建新用户
                </button>
              </p>
            </>
          ) : (
            <>
              <label className="block text-sm font-medium text-gray-700 mb-1">新用户名称</label>
              <input
                type="text"
                value={newUserName}
                onChange={(e) => setNewUserName(e.target.value)}
                placeholder="输入用户名（如：实验员A）"
                className="w-full border border-gray-300 rounded-lg px-4 py-2.5 mb-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                onKeyDown={(e) => e.key === 'Enter' && handleCreateUser()}
              />
              {error && <p className="text-red-500 text-sm mb-3">{error}</p>}
              <button
                onClick={handleCreateUser}
                className="w-full bg-green-600 text-white rounded-lg py-2.5 font-medium hover:bg-green-700 transition mb-2"
              >
                创建并登录
              </button>
              <button
                onClick={() => { setCreateMode(false); setError(''); }}
                className="w-full text-gray-500 text-sm hover:underline"
              >
                返回Token登录
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // 仪表盘
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">实验仪表盘</h1>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <DashboardCard title="进行中实验" value={String(stats.running)} subtitle={`共 ${stats.total} 次实验`} color="blue" />
        <DashboardCard title="活跃账号" value={`${stats.activeAccounts}/${stats.totalAccounts}`} subtitle={`可评论 ${stats.commentableAccounts}`} color="green" />
        <DashboardCard title="今日评论配额" value={`${stats.usedComments}/${stats.maxComments}`} subtitle="已用/总量" color="purple" />
        <DashboardCard title="当前时间" value={new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} subtitle={new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })} color="blue" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">快捷操作</h2>
          <div className="space-y-3">
            <button
              onClick={() => router.push('/accounts')}
              className="w-full text-left px-4 py-3 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 transition"
            >
              管理微博账号 → 扫码登录获取Cookie
            </button>
            <button
              onClick={() => router.push('/experiment')}
              className="w-full text-left px-4 py-3 bg-green-50 text-green-700 rounded-lg hover:bg-green-100 transition"
            >
              创建新实验 → 筛选帖子并分组
            </button>
            <button
              onClick={() => router.push('/data')}
              className="w-full text-left px-4 py-3 bg-purple-50 text-purple-700 rounded-lg hover:bg-purple-100 transition"
            >
              查看实验数据 → 四张固定数据表
            </button>
          </div>

          {/* 测试工具 */}
          <h3 className="text-sm font-semibold text-gray-500 mt-6 mb-3">🔧 功能测试</h3>
          <div className="space-y-2">
            <button
              onClick={handleTestCollect}
              disabled={testCollectResult.loading}
              className="w-full text-left px-4 py-2.5 bg-yellow-50 text-yellow-700 rounded-lg hover:bg-yellow-100 transition disabled:opacity-50 text-sm"
            >
              {testCollectResult.loading ? '⏳ 测试中...' : '🧪 测试采集 — 搜索"日常"并筛选'}
            </button>
            {testCollectResult.data && (
              <div className={`mt-1 p-2 rounded text-xs ${testCollectResult.data.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                <p className="font-medium">{testCollectResult.data.success ? '✅' : '❌'} 账号: {testCollectResult.data.account} | {testCollectResult.data.elapsed}ms</p>
                {testCollectResult.data.midsFound !== undefined && (
                  <p>搜索到 {testCollectResult.data.midsFound} 条mid，筛选 {testCollectResult.data.postsScreened} 条，通过 {testCollectResult.data.postsPassed} 条</p>
                )}
                {testCollectResult.data.error && <p className="text-red-600">{testCollectResult.data.error}</p>}
                {testCollectResult.data.log && (
                  <details className="mt-1"><summary className="cursor-pointer">详细日志</summary>
                    {testCollectResult.data.log.map((l: string, i: number) => <p key={i} className="whitespace-pre-wrap">{l}</p>)}
                  </details>
                )}
              </div>
            )}
            {testCollectResult.error && (
              <div className="mt-1 p-2 rounded text-xs bg-red-50 text-red-700">{testCollectResult.error}</div>
            )}

            <button
              onClick={handleTestComment}
              disabled={testCommentResult.loading}
              className="w-full text-left px-4 py-2.5 bg-orange-50 text-orange-700 rounded-lg hover:bg-orange-100 transition disabled:opacity-50 text-sm"
            >
              {testCommentResult.loading ? '⏳ 测试中...' : '💬 测试评论 — 发一条并立即删除'}
            </button>
            {testCommentResult.data && (
              <div className={`mt-1 p-2 rounded text-xs ${testCommentResult.data.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                <p className="font-medium">{testCommentResult.data.success ? '✅' : '❌'} 账号: {testCommentResult.data.account} | {testCommentResult.data.elapsed}ms</p>
                {testCommentResult.data.mid && <p>目标微博: {testCommentResult.data.mid}</p>}
                {testCommentResult.data.commentId && <p>评论ID: {testCommentResult.data.commentId} {testCommentResult.data.deleted ? '(已删除)' : ''}</p>}
                {testCommentResult.data.error && <p className="text-red-600">{testCommentResult.data.error}</p>}
                {testCommentResult.data.log && (
                  <details className="mt-1"><summary className="cursor-pointer">详细日志</summary>
                    {testCommentResult.data.log.map((l: string, i: number) => <p key={i} className="whitespace-pre-wrap">{l}</p>)}
                  </details>
                )}
              </div>
            )}
            {testCommentResult.error && (
              <div className="mt-1 p-2 rounded text-xs bg-red-50 text-red-700">{testCommentResult.error}</div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4">实验规则速查</h2>
          <div className="space-y-2 text-sm text-gray-600">
            <p>- 实验分组：控制组 / 低显著组 / 高显著组，1:1:1 随机分配</p>
            <p>- 采集批次：16:00 / 18:00 / 20:00 分批建池</p>
            <p>- 评论发送：每天 20:00，评论权限 19:30 预先检测</p>
            <p>- 数据监控：t0 / t2h / t4h / t8h / t12h / t24h / t48h / t72h</p>
            <p>- 多账号轮换 + 双账号重试，避免风控</p>
            <p>- 评论仅使用预设模板，禁止自创</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function DashboardCard({
  title,
  value,
  subtitle,
  color,
}: {
  title: string;
  value: string;
  subtitle: string;
  color: 'blue' | 'green' | 'purple';
}) {
  const colors = {
    blue: 'bg-blue-50 border-blue-200',
    green: 'bg-green-50 border-green-200',
    purple: 'bg-purple-50 border-purple-200',
  };

  return (
    <div className={`rounded-xl border p-5 ${colors[color]}`}>
      <h3 className="text-sm font-medium text-gray-600">{title}</h3>
      <p className="text-3xl font-bold mt-1">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{subtitle}</p>
    </div>
  );
}