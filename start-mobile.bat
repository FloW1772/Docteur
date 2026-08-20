@echo off
chcp 65001 >nul
title Docteur - Mode Mobile (build de production)

REM ============================================================
REM  start-mobile.bat
REM  Usage : telephone via Wi-Fi, meme PC eteint par la suite.
REM  Ce script :
REM    1. Construit le build de production (dist/)
REM    2. Lance le cortex-server en mode reseau local (port 3001)
REM    3. Sert le build via vite preview sur le reseau (port 5173)
REM  Le service worker Workbox met en cache toute l'app au 1er
REM  chargement. Le telephone peut ensuite ouvrir l'app meme PC eteint.
REM  Contraste avec start-local.bat qui sert le mode dev (pas de SW).
REM ============================================================

echo.
echo ================================================
echo   DOCTEUR - Mode Mobile (production + PWA)
echo ================================================
echo.

REM [1/4] Verification Ollama
echo [1/4] Verification Ollama...
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I /N "ollama.exe" >NUL
if "%ERRORLEVEL%"=="0" (
    echo Ollama tourne deja.
) else (
    echo Lancement Ollama...
    start "Ollama" cmd /k "ollama serve"
    timeout /t 4 /nobreak >nul
)

REM [1b] Generation du certificat HTTPS (si absent)
echo.
echo [1b] Certificat HTTPS...
cd /d C:\dev\Docteur
node scripts/gen-cert.mjs
if errorlevel 1 (
    echo ERREUR : generation du certificat echouee.
    pause
    exit /b 1
)

REM [2/4] Build de production (bloquant - attend la fin du build)
echo.
echo [2/4] Build de production en cours...
echo (peut prendre 10-20 secondes)
cd /d C:\dev\Docteur
call npm run build
if errorlevel 1 (
    echo ERREUR : le build a echoue. Verifier les erreurs ci-dessus.
    pause
    exit /b 1
)
echo Build termine avec succes.

REM [3/4] Cortex-server en mode reseau local
echo.
echo [3/4] Lancement du cortex-server (reseau local, port 3001)...
start "Cortex Server - Mobile" cmd /k "cd /d C:\dev\Docteur\cortex-server && npm run dev:local"
timeout /t 5 /nobreak >nul

REM [4/4] Serveur du build de production (vite preview)
echo.
echo [4/4] Lancement du serveur de production (port 5173)...
start "Docteur Preview - Mobile" cmd /k "cd /d C:\dev\Docteur && npm run preview:mobile"
timeout /t 4 /nobreak >nul

REM Affichage des adresses reseau disponibles
echo.
echo ================================================
echo   Adresses IP du PC sur le reseau local :
echo ================================================
ipconfig | findstr "192.168"
echo.
echo   Sur le telephone (meme Wi-Fi) :
echo   https://[adresse ci-dessus]:5173
echo.
echo   IMPORTANT : certificat auto-signe (necessite HTTPS pour le SW).
echo   Premiere visite : accepter l'avertissement de certificat du navigateur
echo   (bouton Avance puis Continuer), puis laisser l'app se charger
echo   completement - le service worker met en cache toute l'app.
echo   Visites suivantes : l'app s'ouvre meme PC eteint.
echo.
echo   Garder les fenetres ouvertes tant que le PC est allume.
echo   Fermer pour tout arreter.
echo ================================================
echo.

timeout /t 5 /nobreak >nul
exit
