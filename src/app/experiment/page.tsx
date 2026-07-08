'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../auth-context';

interface ExperimentRun {
  id: string;
  experiment_date: string;
  status: string;
  qualified_count?: number;
  total_posts?: number;
  batch_count?: number;
  pool_full?: boolean;
  created_at: string;
}

interface ExperimentPost {
  id: string;
  post_id: string;
  content: string;
  author_name: string;
  comments_count: number;
  post_group: string;
}

interface LogRow {
  id: string;
  post_id: string;
  post_group: string;
  comment_content: string;
  status: string;
  weibo_comment_id?: string;
  sent_at?: string;
  error_message?: string;
}

export default function ExperimentPage() {
  const { token, isAuthenticated } = useAuth();
  const [experiments, setExperiments] = useState<ExperimentRun[]>([]);
  const [selected, setSelected] = useState<ExperimentRun | null>(null);
  const [posts, setPosts] = useState<ExperimentPost[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchExperiments = useCallback(async () => {
    try {
      const resp = await fetch('/api/experiment', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json();
      if (data.experiments) setExperiments(data.experiments);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (isAuthenticated) fetchExperiments();
  }, [isAuthenticated, fetchExperiments]);

  const selectExperiment = async (exp: ExperimentRun) => {
    if (selected?.id === exp.id) {
      setSelected(null);
      setPosts([]);
      setLogs([]);
      return;
    }
    setSelected(exp);
    setDetailLoading(true);
    try {
      const resp = await fetch(`/api/experiment?id=${exp.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json();
      setPosts(data.posts || []);
      setLogs(data.interventionLogs || []);
    } catch {
      // ignore
    }
    setDetailLoading(false);
  };

  const statusBadge = (status: string) => {
    const map: Record<string, { label: string; cls: string }> = {
      collecting: { label: '采集中', cls: 'bg-yellow-100 text-yellow-700' },
      ready: { label: '待发送', cls: 'bg-blue-100 text-blue-700' },
      running: { label: '进行中', cls: 'bg-green-100 text-green-700' },
      completed: { label: '已完成', cls: 'bg-gray-100 text-gray-600' },
      failed: { label: '失败', cls: 'bg-red-100 text-red-700' },
    };
    const m = map[status] || { label: status, cls: 'bg-gray-100 text-gray-600' };
    return <span className={`px-2 py-0.5 rounded text-xs font-medium ${m.cls}`}>{m.label}</span>;
  };

  const groupLabel = (group: string) => {
    const map: Record<string, string> = {
      control: '控制组', low: '低显著', high: '高显著',
    };
    return map[group] || group;
  };

  const groupColor = (group: string) => {
    const map: Record<string, string> = {
      control: 'bg-gray-50 border-gray-200',
      low: 'bg-orange-50 border-orange-200',
      high: 'bg-red-50 border-red-200',
    };
    return map[group] || 'bg-gray-50 border-gray-200';
  };

  if (!isAuthenticated) return null;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">实验管理</h1>

      {/* 实验列表 */}
      <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">实验记录</h2>
        {loading ? (
          <p className="text-gray-500 py-4">加载中...</p>
        ) : experiments.length === 0 ? (
          <p className="text-gray-400 py-8 text-center">暂无实验记录，调度器将在每天 16:00 自动开始采集</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-2 px-3 font-medium">日期</th>
                  <th className="py-2 px-3 font-medium">状态</th>
                  <th className="py-2 px-3 font-medium">合格帖</th>
                  <th className="py-2 px-3 font-medium">实验帖</th>
                  <th className="py-2 px-3 font-medium">批次</th>
                  <th className="py-2 px-3 font-medium">创建时间</th>
                </tr>
              </thead>
              <tbody>
                {experiments.map((exp) => (
                  <tr
                    key={exp.id}
                    onClick={() => selectExperiment(exp)}
                    className={`border-b last:border-0 cursor-pointer transition ${selected?.id === exp.id ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                  >
                    <td className="py-2.5 px-3 font-medium">{exp.experiment_date}</td>
                    <td className="py-2.5 px-3">{statusBadge(exp.status)}</td>
                    <td className="py-2.5 px-3">{exp.qualified_count ?? '-'}</td>
                    <td className="py-2.5 px-3">{exp.total_posts ?? '-'}</td>
                    <td className="py-2.5 px-3">{exp.batch_count ?? '-'}{exp.pool_full ? ' ✓' : ''}</td>
                    <td className="py-2.5 px-3 text-gray-400 text-xs">
                      {exp.created_at ? new Date(exp.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 实验详情 */}
      {selected && (
        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">
              实验详情 — {selected.experiment_date}
              <span className="ml-2">{statusBadge(selected.status)}</span>
            </h3>
            <span className="text-xs text-gray-400">
              {posts.length} 帖 · {logs.length} 条评论
            </span>
          </div>

          {detailLoading ? (
            <p className="text-gray-500 py-4">加载详情...</p>
          ) : posts.length === 0 ? (
            <p className="text-gray-400 py-4 text-center">暂无帖子数据</p>
          ) : (
            <>
              {/* 按组统计 */}
              <div className="flex gap-4 mb-4 text-sm">
                {(['control', 'low', 'high'] as const).map((group) => {
                  const count = posts.filter(p => p.post_group === group).length;
                  const sent = logs.filter(l => l.post_group === group && l.status === 'sent').length;
                  return (
                    <div key={group} className={`px-3 py-2 rounded-lg border ${groupColor(group)}`}>
                      <span className="font-medium">{groupLabel(group)}</span>
                      <span className="ml-2 text-gray-500">{count} 帖</span>
                      {sent > 0 && <span className="ml-2 text-green-600">已评 {sent}</span>}
                    </div>
                  );
                })}
              </div>

              {/* 三列帖子分组 */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {(['control', 'low', 'high'] as const).map((group) => {
                  const groupPosts = posts.filter((p) => p.post_group === group);
                  return (
                    <div key={group}>
                      <h4 className="font-medium mb-2 text-sm">
                        {groupLabel(group)} ({groupPosts.length})
                      </h4>
                      <div className="space-y-2 max-h-[500px] overflow-y-auto">
                        {groupPosts.map((post) => {
                          const log = logs.find(l => l.post_id === post.id);
                          return (
                            <div key={post.id} className={`p-3 rounded-lg border text-xs ${groupColor(group)}`}>
                              <p className="text-gray-700 line-clamp-2 mb-1">{post.content}</p>
                              <p className="text-gray-400">
                                @{post.author_name} · 评论{post.comments_count}
                              </p>
                              {log && (
                                <div className="mt-1 pt-1 border-t border-gray-200">
                                  {log.status === 'sent' ? (
                                    <span className="text-green-600">✓ 已评论: {log.comment_content?.substring(0, 15)}...</span>
                                  ) : log.status === 'failed' ? (
                                    <span className="text-red-400" title={log.error_message}>✗ 失败</span>
                                  ) : (
                                    <span className="text-gray-400">待发送</span>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
