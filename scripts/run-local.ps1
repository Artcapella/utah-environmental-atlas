# Run YOUtah Environmental locally with Supabase disabled: the app ignores any
# Supabase credentials in .env.local and serves its built-in data instead.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\run-local.ps1 [-Port 8000]
param([int]$Port = 8000)

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:SUPABASE_ENABLED = 'false'

& "$root\.venv\Scripts\python.exe" -m uvicorn app:app --reload --port $Port
