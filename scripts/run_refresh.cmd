@echo off
REM Energy Dashboard - monthly data refresh wrapper.
REM Invoked by the Windows Task Scheduler task "Energy Dashboard Monthly Refresh".
REM Re-downloads the Ember dataset and rebuilds public\energy.json.
REM %~dp0 = this script's folder (scripts\), so it works regardless of CWD.
setlocal
set "PY=C:\Python314\python.exe"
if not exist "%PY%" set "PY=py"
"%PY%" "%~dp0refresh_data.py"
endlocal
