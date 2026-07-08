import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * 全局代理：对 /api/* 路径进行 Token 认证
 * 排除 /api/auth/check（无需认证，用于前端验证Token）
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 仅拦截 API 路由
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // /api/auth/check 不需要认证（它自己处理Token校验）
  if (pathname === '/api/auth/check') {
    return NextResponse.next();
  }

  // 检查 Authorization header
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: '未提供认证Token，请设置 Authorization: Bearer <token>' },
      { status: 401 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
