@echo off
chcp 65001 >nul
title Docteur - Mode Dev Reseau (HTTP - pas de PWA)

echo ========================================
echo    DOCTEUR - Mode DEV RESEAU
echo    Acces depuis un autre poste (HTTP)
echo    PAS le mode PWA/mobile !
echo    Pour la PWA mobile : start-mobile.bat
echo    Ne pas utiliser sur reseau public !
echo ========================================
echo.

REM Verification et lancement d'Ollama
echo [1/3] Verification Ollama...
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I /N "ollama.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo Ollama tourne deja, on continue.
) else (
    echo Lancement Ollama...
    start "Ollama" cmd /k "ollama serve"
    timeout /t 4 /nobreak >nul
)

REM Lancement du serveur cognitif en mode reseau local
REM Meme repertoire et meme base de donnees que Docteur.bat
REM Seule difference : LOCAL_NETWORK=true
echo [2/3] Lancement du serveur cognitif (mode reseau local)...
start "Cortex Server - Local Network" cmd /k "cd /d C:\dev\Docteur\cortex-server && npm run dev:local"

REM Pause pour laisser le serveur demarrer et afficher l'IP
timeout /t 5 /nobreak >nul

REM Lancement du frontend en mode reseau local (HTTP - pas de SW, pas de PWA)
echo [3/3] Lancement du frontend dev reseau (HTTP, sans SW)...
start "Docteur Frontend - Local Network" cmd /k "cd /d C:\dev\Docteur && npm run dev:local"

REM Pause pour laisser Vite demarrer
timeout /t 5 /nobreak >nul

REM Ouverture de Chrome (acces local PC inchange)
echo Ouverture de Docteur dans Chrome...
start chrome --app=http://localhost:5173 2>nul
if errorlevel 1 (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:5173
)

echo.
echo ========================================
echo    Docteur est lance en mode DEV RESEAU
echo    (HTTP uniquement - sans service worker)
echo    -^> Adresse IP affichee dans la
echo       fenetre Cortex Server
echo    -^> Ouvrir cette adresse sur un autre
echo       poste du reseau (meme Wi-Fi)
echo    ATTENTION : pas de PWA, pas de cache
echo    hors-ligne. Pour le vrai mode mobile
echo    avec SW, utiliser start-mobile.bat
echo    Garder les fenetres ouvertes.
echo ========================================
echo.

timeout /t 3 /nobreak >nul
exit
