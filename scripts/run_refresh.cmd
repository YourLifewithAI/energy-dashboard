@echo off
REM Energy Dashboard - monthly data refresh wrapper.
REM Invoked by the Windows Task Scheduler task "Energy Dashboard Monthly Refresh".
REM 1) Re-downloads the Ember dataset and rebuilds public\energy.json.
REM 2) If the data changed, commits & pushes it so the GitHub copy (and the
REM    GitHub Pages site, which redeploys on push) stays current.
REM %~dp0 = this script's folder (scripts\), so it works regardless of CWD.
setlocal
set "PY=C:\Python314\python.exe"
if not exist "%PY%" set "PY=py"
set "REPO=%~dp0.."

"%PY%" "%~dp0refresh_data.py"
set "RC=%ERRORLEVEL%"

REM --- best-effort auto-publish (never overrides the refresh's exit code) ---
git -C "%REPO%" diff --quiet -- public/energy.json
if errorlevel 1 (
  echo Data changed - committing and pushing refreshed energy.json.
  git -C "%REPO%" add public/energy.json
  git -C "%REPO%" commit -m "Monthly data refresh (%DATE%)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  git -C "%REPO%" push
) else (
  echo No data change this run - nothing to publish.
)

endlocal & exit /b %RC%
