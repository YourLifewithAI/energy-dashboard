# Registers the Windows Task Scheduler job that refreshes the dashboard data
# on the LAST DAY of every month at 04:00. Re-run any time (idempotent: /F).
#
#   powershell -ExecutionPolicy Bypass -File scripts\register_task.ps1
#
$ErrorActionPreference = "Stop"
$taskName = "Energy Dashboard Monthly Refresh"
$wrapper  = Join-Path $PSScriptRoot "run_refresh.cmd"
if (-not (Test-Path $wrapper)) { throw "Wrapper not found: $wrapper" }

# schtasks supports the LASTDAY-of-month modifier, which the New-ScheduledTaskTrigger
# cmdlet does not, so we create the trigger here and refine settings below.
schtasks /Create /TN $taskName /TR "`"$wrapper`"" /SC MONTHLY /MO LASTDAY /M "*" /ST 04:00 /F | Out-Null

# Run as soon as possible after a missed start (machine off/asleep); 30-minute cap.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Set-ScheduledTask -TaskName $taskName -Settings $settings | Out-Null

Write-Host "Registered '$taskName' - last day of each month, 04:00, StartWhenAvailable."
