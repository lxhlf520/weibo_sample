@echo off
chcp 65001 >nul
echo ============================================
echo   微博实验平台 - 启动调度器
echo ============================================
echo.

:: ── 邮件通知配置（网易163 SMTP）──
set SMTP_USER=13662293949@163.com
set SMTP_AUTH_CODE=LPsXNSeDj5w3w2dv

echo [邮件] SMTP_USER=%SMTP_USER%
echo [邮件] 收件人: 792787208@qq.com
echo.

echo 启动调度器...
npx tsx src/jobs/scheduler.ts
pause
