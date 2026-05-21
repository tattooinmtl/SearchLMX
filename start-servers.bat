@echo off
title SearchLMx Quake Engine - Server Startup
color 0A

echo.
echo  ==========================================
echo   SearchLMx Quake Engine - Server Startup
echo  ==========================================
echo.

:: Paths
set LLAMA_DIR=C:\SearchLMx\llama
set MODEL_PATH=C:\SearchLMx\Models\Llama-3.2-3B.Q4_K_M.gguf
set LLAMA_EXE=%LLAMA_DIR%\llama-server.exe
set PORT=8080
set APP_DIR=C:\SearchLMx

:: Check exe exists
if not exist "%LLAMA_EXE%" (
    echo [ERROR] llama-server.exe not found at:
    echo         %LLAMA_EXE%
    pause
    exit /b 1
)

:: Check model exists
if not exist "%MODEL_PATH%" (
    echo [ERROR] Model not found at:
    echo         %MODEL_PATH%
    pause
    exit /b 1
)

:: Kill any existing llama-server on port 8080
echo [1/4] Checking for existing llama-server instances...
tasklist /FI "IMAGENAME eq llama-server.exe" 2>nul | find /I "llama-server.exe" >nul
if %ERRORLEVEL% == 0 (
    echo        Found existing instance - stopping it...
    taskkill /F /IM llama-server.exe >nul 2>&1
    timeout /t 2 /nobreak >nul
    echo        Done.
) else (
    echo        No existing instance found.
)

:: Start llama-server in a separate minimized window
echo.
echo [2/4] Starting Llama server...
echo        Model : Llama-3.2-3B.Q4_K_M.gguf
echo        Port  : %PORT%
echo        CTX   : 4096 tokens
echo.

start "Llama Server [port %PORT%]" /MIN "%LLAMA_EXE%" ^
    -m "%MODEL_PATH%" ^
    --port %PORT% ^
    -c 4096 ^
    -n 1024 ^
    --temp 0.3 ^
    --repeat-penalty 1.1 ^
    -np 1 ^
    --log-disable

:: Wait for server to become healthy (poll every 3 seconds, max 40 attempts = 2 minutes)
echo [3/4] Waiting for model to load into memory...
echo        (This takes 20-60 seconds on first load)
echo.

set /a ATTEMPTS=0
set /a MAX_ATTEMPTS=40

:POLL_LOOP
set /a ATTEMPTS+=1
set /a DOTS=ATTEMPTS %% 4

if %ATTEMPTS% GTR %MAX_ATTEMPTS% (
    echo.
    echo [ERROR] Server did not become healthy after 2 minutes.
    echo         Check the "Llama Server" console window for errors.
    pause
    exit /b 1
)

<nul set /p =        Attempt %ATTEMPTS%/%MAX_ATTEMPTS% - Loading...
powershell -NoProfile -Command ^
    "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/health' -TimeoutSec 2 -UseBasicParsing; Write-Host ' OK'; exit 0 } catch { Write-Host ' ...'; exit 1 }" 2>nul
if %ERRORLEVEL% == 0 goto SERVER_READY

timeout /t 3 /nobreak >nul
goto POLL_LOOP

:SERVER_READY
echo.
echo  ==========================================
echo   Llama Server READY on port %PORT%!
echo  ==========================================
echo.

:: Launch the Electron app
echo [4/4] Launching SearchLMx Quake Engine application...
echo.
cd /d "%APP_DIR%"
npm start

echo.
echo Application closed. Llama server is still running in background.
echo To stop it: taskkill /F /IM llama-server.exe
echo.
pause
