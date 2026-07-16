/**
 * 评论模板自动同步
 * ============================================================================
 * 调度器启动时运行，确保 MongoDB 中的 comment_templates 与代码定义一致。
 * 使用 upsert（按 post_group + content 去重），不会覆盖已有但会新增缺失。
 */

import { upsert, query } from './db';

interface TemplateRow {
  post_group: string;
  content: string;
  sort_order: number;
  is_active: boolean;
}

/** 默认 4 条评论模板（low 组 2 条 + high 组 2 条，high 组带 AI 标记前缀） */
const DEFAULT_TEMPLATES: TemplateRow[] = [
  { post_group: 'low', content: '路过看到这条。', sort_order: 1, is_active: true },
  { post_group: 'low', content: '刷到这条了。', sort_order: 2, is_active: true },
  { post_group: 'high', content: 'AI生成评论：路过看到这条。', sort_order: 3, is_active: true },
  { post_group: 'high', content: 'AI生成评论：刷到这条了。', sort_order: 4, is_active: true },
];

/**
 * 同步默认模板到 comment_templates 集合。
 * 新增缺失模板，已有模板（按 post_group + content 匹配）保持不变。
 */
export async function ensureTemplates(): Promise<{ created: number; existing: number }> {
  let created = 0;
  let existing = 0;

  for (const tpl of DEFAULT_TEMPLATES) {
    // 按 post_group + content 去重
    const { rows } = await query<TemplateRow & { id: string }>(
      'comment_templates',
      { post_group: tpl.post_group, content: tpl.content },
    );

    if (rows.length === 0) {
      await upsert(
        'comment_templates',
        { post_group: tpl.post_group, content: tpl.content },
        {
          post_group: tpl.post_group,
          content: tpl.content,
          sort_order: tpl.sort_order,
          is_active: tpl.is_active,
          created_at: new Date().toISOString(),
        },
      );
      created++;
    } else {
      // 已有模板，确保 is_active 和 sort_order 最新
      await upsert(
        'comment_templates',
        { post_group: tpl.post_group, content: tpl.content },
        {
          sort_order: tpl.sort_order,
          is_active: tpl.is_active,
        },
      );
      existing++;
    }
  }

  // 禁用多余的低质量模板（不在 DEFAULT_TEMPLATES 中的标记为 inactive）
  const { rows: allActive } = await query<TemplateRow & { id: string }>(
    'comment_templates',
    { is_active: true },
  );

  const defaultContents = new Set(DEFAULT_TEMPLATES.map((t) => t.content));
  let disabled = 0;

  for (const row of allActive) {
    if (!defaultContents.has(row.content)) {
      await upsert(
        'comment_templates',
        { id: row.id },
        { is_active: false },
      );
      disabled++;
    }
  }

  if (disabled > 0) {
    console.log(`[模板同步] 已禁用 ${disabled} 条旧模板`);
  }

  return { created, existing };
}
