import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, createUser, extractToken } from '@/lib/auth';

/**
 * POST /api/auth/check
 * Body: { token?: string } 或使用 Authorization header
 * 验证Token有效性，返回用户信息
 */
export async function POST(request: NextRequest) {
  try {
    let token: string | null = null;

    // 优先从 body 获取 token
    const body = await request.json().catch(() => ({}));
    if (body.token) {
      token = body.token;
    } else {
      // 从 Authorization header 获取
      token = extractToken(request);
    }

    if (!token) {
      return NextResponse.json({ valid: false, error: '未提供Token' }, { status: 400 });
    }

    const user = await verifyToken(token);
    if (user) {
      return NextResponse.json({ valid: true, user: { id: user.id, name: user.name } });
    }

    return NextResponse.json({ valid: false, error: 'Token无效' }, { status: 401 });
  } catch {
    return NextResponse.json({ valid: false, error: '请求处理失败' }, { status: 500 });
  }
}

/**
 * PUT /api/auth/check
 * Body: { name: string }
 * 创建新的实验用户（生成Token），需要服务密钥或管理员权限
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const name = body.name?.trim();

    if (!name || name.length < 2) {
      return NextResponse.json({ error: '用户名至少2个字符' }, { status: 400 });
    }

    const user = await createUser(name);
    if (!user) {
      return NextResponse.json({ error: '创建用户失败，可能名称重复' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      user: { id: user.id, name: user.name, token: user.token },
    });
  } catch {
    return NextResponse.json({ error: '创建用户失败' }, { status: 500 });
  }
}
