import { v4 as uuidv4 } from 'uuid';
import { query, maybeOne, insert } from './db';

export interface ExperimentUser {
  id: string;
  token: string;
  name: string;
  created_at: string;
}

/**
 * 从 Authorization header 中提取 Bearer token
 */
export function extractToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim();
}

/**
 * 验证 Token 并返回用户信息
 */
export async function verifyToken(token: string): Promise<ExperimentUser | null> {
  if (!token || token.length < 10) return null;
  try {
    return await maybeOne<ExperimentUser>('experiment_users', { token });
  } catch {
    return null;
  }
}

/**
 * 创建新的实验用户（生成唯一Token）
 */
export async function createUser(name: string): Promise<ExperimentUser | null> {
  try {
    const token = uuidv4();
    return await insert<ExperimentUser>('experiment_users', { token, name });
  } catch {
    return null;
  }
}

/**
 * 从请求中验证身份，返回用户或 401 响应
 */
export async function authenticateRequest(request: Request): Promise<ExperimentUser | Response> {
  const token = extractToken(request);
  if (!token) {
    return new Response(JSON.stringify({ error: '未提供认证Token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const user = await verifyToken(token);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Token无效或已过期' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return user;
}