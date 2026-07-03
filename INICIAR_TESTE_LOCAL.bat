@echo off
setlocal
cd /d "%~dp0"
set PORT=8014

echo.
echo Iniciando o Bolao OAZ - Brasil x Noruega em modo local...
echo O navegador abrira em: http://localhost:%PORT%/docs/html/palpite.html
echo Para parar o teste, feche esta janela.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 700; Start-Process 'http://localhost:%PORT%/docs/html/palpite.html'"

where py >nul 2>&1
if not errorlevel 1 (
  py -m http.server %PORT%
  goto :eof
)

where python >nul 2>&1
if not errorlevel 1 (
  python -m http.server %PORT%
  goto :eof
)

echo.
echo Nao foi possivel encontrar o Python neste computador.
echo Instale o Python marcando a opcao Add Python to PATH e execute este arquivo novamente.
pause
