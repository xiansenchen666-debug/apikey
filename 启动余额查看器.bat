@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo ??? Python????? Python?
  pause
  exit /b 1
)

echo ?????? 8787 ????...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$pids = (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); foreach($id in $pids){ if($id -and $id -ne 0){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }"

echo ???????????...
start "" "http://127.0.0.1:8787"
python app.py
pause
