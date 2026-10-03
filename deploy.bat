@echo off
chcp 65001 >nul
title نشر بوت هسه على Railway
cd /d "%~dp0"

echo.
echo ===============================================
echo    نشر بوت هسه على Railway
echo ===============================================
echo.

where railway >nul 2>nul
if errorlevel 1 (
  echo [!] Railway CLI مو منصب.
  echo     نصبه من: https://docs.railway.com/guides/cli
  echo.
  pause
  exit /b 1
)

echo [1/3] ربط المشروع...
call railway link --project b0f18c8c-2cbb-4dcd-b54f-487aeeacfeae --environment production --service bot
if errorlevel 1 goto failed

echo.
echo [2/3] رفع الكود ونشره... (ياخذ دقيقة او دقيقتين)
call railway up --detach
if errorlevel 1 goto failed

echo.
echo [3/3] تم الرفع.
echo.
echo ===============================================
echo    خلص. ارجع للمحادثة وقل "نشرته"
echo ===============================================
echo.
pause
exit /b 0

:failed
echo.
echo [!] صار خطأ. صور الشاشة وارسلها بالمحادثة.
echo.
pause
exit /b 1
