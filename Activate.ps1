Set-Location -Path $PSScriptRoot

# Activate virtual environment
. "$PSScriptRoot\.venv\Scripts\Activate.ps1"

# Start backend server
python -m uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000
