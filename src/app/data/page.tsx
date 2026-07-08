'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../auth-context';

interface ExperimentRun {
  id: string;
  experiment_date: string;
  status: string;
  qualified_count?: number;
  total_posts?: number;
  batch_count?: number;
  created_at: string;
}

export default function DataPage() {
  const { token, isAuthenticated } = useAuth();
  const [experiments, setExperiments] = useState<ExperimentRun[]>([]);
  const [selectedExpId, setSelectedExpId] = useState<string | null>(null);
  const [tab, setTab] = useState<'snapshots' | 'interventions' | 'outcome' | 'comments'>('snapshots');
  const [data, setData] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);

  // 筛选状态
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [searchText, setSearchText] = useState('');

  const fetchExperiments = useCallback(async () => {
    try {
      const resp = await fetch('/api/experiment', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await resp.json();
      setExperiments(d.experiments || []);
    } catch {
      // ignore
    }
  }, [token]);

  useEffect(() => {
    if (isAuthenticated) fetchExperiments();
  }, [isAuthenticated, fetchExperiments]);

  // 筛选后的实验列表
  const filteredExperiments = useMemo(() => {
    return experiments.filter((exp) => {
      if (statusFilter !== 'all' && exp.status !== statusFilter) return false;
      if (dateFrom && exp.experiment_date < dateFrom) return false;
      if (dateTo && exp.experiment_date > dateTo) return false;
      if (searchText) {
        const s = searchText.toLowerCase();
        const matchDate = exp.experiment_date.includes(s);
        const matchStatus = exp.status.includes(s);
        const matchId = String(exp.id).includes(s);
        if (!matchDate && !matchStatus && !matchId) return false;
      }
      return true;
    });
  }, [experiments, statusFilter, dateFrom, dateTo, searchText]);

  const fetchData = async (type: string) => {
    if (!selectedExpId) return;
    setLoading(true);
    try {
      const resp = await fetch(`/api/data?experimentId=${selectedExpId}&type=${type}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await resp.json();
      if (type === 'snapshots') {
        setData(d.snapshots || []);
      } else if (type === 'interventions') {
        setData(d.logs || []);
      } else if (type === 'outcome') {
        setData(d.outcome || []);
      } else if (type === 'comments') {
        setData(d.comments || []);
      }
    } catch {
      // ignore
    }
    setLoading(false);
  };

  useEffect(() => {
    if (selectedExpId) fetchData(tab);
  }, [selectedExpId, tab]);

  const tabs = [
    { key: 'snapshots', label: 'Post快照' },
    { key: 'interventions', label: '干预日志' },
    { key: 'comments', label: '评论快照' },
    { key: 'outcome', label: '结果分析' },
  ] as const;

  const statusOptions = [
    { key: 'all', label: '全部' },
    { key: 'collecting', label: '采集中' },
    { key: 'ready', label: '待发送' },
    { key: 'running', label: '进行中' },
    { key: 'completed', label: '已完成' },
    { key: 'failed', label: '失败' },
  ];

  const exportData = () => {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tab}_experiment${selectedExpId}_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
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

  if (!isAuthenticated) return null;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">数据查看</h1>

      {/* 筛选区 */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          {/* 状态筛选 */}
          <div className="flex gap-1">
            {statusOptions.map((opt) => (
              <button
                key={opt.key}
                onClick={() => setStatusFilter(opt.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${statusFilter === opt.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* 日期范围 */}
          <div className="flex items-center gap-2 ml-2">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="border rounded-lg px-2 py-1.5 text-xs"
            />
            <span className="text-gray-400 text-xs">至</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="border rounded-lg px-2 py-1.5 text-xs"
            />
          </div>

          {/* 搜索 */}
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="搜索日期/状态/ID..."
            className="border rounded-lg px-3 py-1.5 text-xs w-40 ml-2"
          />

          {/* 结果数 */}
          <span className="text-xs text-gray-400 ml-auto">
            共 {filteredExperiments.length} 条
          </span>
        </div>
      </div>

      {/* 实验列表 */}
      <div className="bg-white rounded-xl shadow-sm mb-6">
        {filteredExperiments.length === 0 ? (
          <div className="text-center py-12 text-gray-400">暂无匹配的实验记录</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500 bg-gray-50">
                  <th className="py-3 px-4 font-medium rounded-tl-xl">日期</th>
                  <th className="py-3 px-4 font-medium">状态</th>
                  <th className="py-3 px-4 font-medium">合格帖</th>
                  <th className="py-3 px-4 font-medium">实验帖</th>
                  <th className="py-3 px-4 font-medium">批次</th>
                  <th className="py-3 px-4 font-medium rounded-tr-xl">创建时间</th>
                </tr>
              </thead>
              <tbody>
                {filteredExperiments.map((exp) => (
                  <tr
                    key={exp.id}
                    onClick={() => setSelectedExpId(exp.id === selectedExpId ? null : exp.id)}
                    className={`border-b last:border-0 cursor-pointer transition ${selectedExpId === exp.id ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                  >
                    <td className="py-2.5 px-4 font-medium">{exp.experiment_date}</td>
                    <td className="py-2.5 px-4">{statusBadge(exp.status)}</td>
                    <td className="py-2.5 px-4">{exp.qualified_count ?? '-'}</td>
                    <td className="py-2.5 px-4">{exp.total_posts ?? '-'}</td>
                    <td className="py-2.5 px-4">{exp.batch_count ?? '-'}</td>
                    <td className="py-2.5 px-4 text-gray-400 text-xs">
                      {exp.created_at ? new Date(exp.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!selectedExpId ? (
        <div className="text-center py-8 text-gray-400">点击上方实验行查看详细数据</div>
      ) : (
        <>
          {/* Tab 切换 */}
          <div className="flex gap-1 mb-4 bg-white rounded-xl shadow-sm p-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${tab === t.key ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* 数据表格 */}
          <div className="bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold">
                {tabs.find((t) => t.key === tab)?.label} ({data.length} 条)
              </h2>
              <button
                onClick={exportData}
                className="text-sm text-blue-600 hover:underline"
                disabled={data.length === 0}
              >
                导出JSON
              </button>
            </div>

            {loading ? (
              <p className="text-gray-500">加载中...</p>
            ) : data.length === 0 ? (
              <p className="text-gray-400 py-8 text-center">暂无数据，请先执行数据采集</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-gray-500">
                      {Object.keys(data[0] as object).slice(0, 8).map((key) => (
                        <th key={key} className="py-2 px-3 font-medium">{key}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.slice(0, 100).map((row, i) => (
                      <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                        {Object.values(row as object).slice(0, 8).map((val, j) => (
                          <td key={j} className="py-2 px-3 text-gray-700 max-w-[200px] truncate">
                            {typeof val === 'object' ? JSON.stringify(val) : String(val ?? '-')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
