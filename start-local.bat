@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo 找不到 python。先装 Python 3.10+，再运行这个文件。
  pause
  exit /b 1
)
python scripts\local_boot.py
pause
