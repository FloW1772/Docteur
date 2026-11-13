@echo off
chcp 65001 >nul 2>&1
REM [H1] run from this launcher's own folder, never from a fixed checkout path: the Desktop shortcut keeps working,
REM  and a checkout elsewhere launches itself (scripts/docteur-launch.mjs also resolves the repository from its own path).
cd /d "%~dp0"
set "DOCTEUR_ROOT=%CD%"

:MENU
cls
echo.
echo  ============================================
echo    DOCTEUR - LANCEUR
echo  ============================================
echo.
echo    [1]  Mode PC (local)
echo         Usage quotidien sur cet ordinateur (moteur stable)
echo         http://localhost:5173
echo.
echo    [2]  Mode reseau (dev)  -- DESACTIVE (LAN-AUTH-1)
echo         Acces depuis un autre poste, sans PWA
echo         http://IP:5173
echo.
echo    [3]  Mode mobile (PWA + hors-ligne)  -- DESACTIVE (LAN-AUTH-1)
echo         Pour le telephone : build + HTTPS + SW
echo         https://IP:5173
echo.
echo    [4]  Verification du projet
echo         Lance check-docteur.bat si present
echo.
echo    [5]  Mode PC developpement
echo         Comme [1], moteur relance a chaque modification du code
echo.
echo    [0]  Quitter
echo.
set "CHOICE="
set /p CHOICE=   Choix :

set "LAUNCH_ARGS="
set "MODE_TITLE=Mode PC local"
if "%CHOICE%"=="1" goto MODE_PC
if "%CHOICE%"=="5" (
    set "LAUNCH_ARGS=--dev"
    set "MODE_TITLE=Mode PC developpement"
    goto MODE_PC
)
if "%CHOICE%"=="2" goto MODE_RESEAU
if "%CHOICE%"=="3" goto MODE_MOBILE
if "%CHOICE%"=="4" goto CHECK
if "%CHOICE%"=="0" goto QUITTER

echo.
echo    Choix invalide. Entrer 0, 1, 2, 3, 4 ou 5.
echo.
pause
goto MENU

REM ============================================================
:MODE_PC
REM  [1] daily use: Ollama + cortex-server (npm start, no file watcher) + frontend (npm run dev)
REM  [5] development (LAUNCH_ARGS=--dev): cortex-server via npm run dev (node --watch)
REM  + Chrome --app http://localhost:5173, unless a Docteur window is already open (exit 10)
REM ============================================================
cls
echo.
echo  ============================================
echo    DOCTEUR - %MODE_TITLE%
echo  ============================================
echo.

REM [STARTUP-2] scripts/docteur-launch.mjs runs the whole sequence: launch lock, ownership of ports 3001 AND 5173
REM  checked before anything starts, Ollama (optional, loopback only), then the backend and the frontend, each reused
REM  when an identified Docteur instance is healthy, otherwise started and awaited until it answers AND is identified.
REM  Exit 0 only then. It never stops a process whose Docteur ownership is not proven (scripts/launcher-identity.mjs).
REM  [STARTUP-3] exit 10 = ready and an already open Docteur window was brought back: no new window.
node scripts/docteur-launch.mjs %LAUNCH_ARGS%
if errorlevel 10 goto BROWSER_ALREADY_OPEN
if errorlevel 1 goto STARTUP_STOPPED

echo Ouverture de Chrome...
start chrome --app=http://localhost:5173 2>nul
if errorlevel 1 (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:5173
)

echo.
echo  ============================================
echo    Lance en %MODE_TITLE%
echo    http://localhost:5173
echo    Garder les fenetres ouvertes.
echo  ============================================
echo.
timeout /t 3 /nobreak >nul
exit /b 0

:BROWSER_ALREADY_OPEN
REM  [STARTUP-3] services verified ready; the existing Docteur window was shown again (nothing opened, nothing closed).
echo.
echo  ============================================
echo    Docteur est deja ouvert : fenetre existante reutilisee.
echo    http://localhost:5173
echo  ============================================
echo.
timeout /t 3 /nobreak >nul
exit /b 0

REM ============================================================
:MODE_RESEAU
REM [SEC-REMED-1] refused before anything starts: the Docteur API has no LAN authentication yet (future LAN-AUTH-1)
goto LAN_REFUSED
REM  Mode dev reseau -- exactement comme start-local.bat
REM  Ollama + cortex-server (npm run dev:local) + frontend (npm run dev:local)
REM  + Chrome --app http://localhost:5173
REM ============================================================
cls
echo.
echo  ============================================
echo    DOCTEUR - Mode reseau (dev, HTTP)
echo  ============================================
echo.

REM [STARTUP-2] unreachable (LAN_REFUSED above); a future LAN-AUTH-1 mode must reuse scripts/docteur-launch.mjs port checks

echo [1/3] Verification Ollama...
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I /N "ollama.exe" >NUL
if "%ERRORLEVEL%"=="0" (
    echo Ollama tourne deja.
) else (
    echo Lancement Ollama...
    start "Ollama" cmd /k "ollama serve"
    timeout /t 4 /nobreak >nul
)

echo [2/3] Lancement du serveur cognitif (mode reseau local)...
start "Cortex Server - Local Network" cmd /k "cd /d "%DOCTEUR_ROOT%\cortex-server" && npm run dev:local"
node scripts/wait-for-cortex.mjs
if errorlevel 1 goto MENU

echo [3/3] Lancement du frontend (HTTP, sans SW)...
start "Docteur Frontend - Local Network" cmd /k "cd /d "%DOCTEUR_ROOT%" && npm run dev:local"
timeout /t 5 /nobreak >nul

echo Ouverture de Chrome...
start chrome --app=http://localhost:5173 2>nul
if errorlevel 1 (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:5173
)

echo.
echo  ============================================
echo    Lance en mode reseau dev (HTTP, sans SW)
echo    Adresse IP dans la fenetre Cortex Server
echo    Ouvrir cette adresse sur le poste distant
echo    SANS mode PWA : hors-ligne non disponible
echo  ============================================
echo.
timeout /t 3 /nobreak >nul
exit /b 0

REM ============================================================
:MODE_MOBILE
REM [SEC-REMED-1] refused before anything starts: its API step needs the LAN, which has no authentication yet (LAN-AUTH-1)
goto LAN_REFUSED
REM  Mode production mobile -- exactement comme start-mobile.bat
REM  Ollama + gen-cert + npm run build + cortex-server (dev:local)
REM  + frontend (preview:mobile)
REM ============================================================
cls
echo.
echo  ============================================
echo    DOCTEUR - Mode mobile (production + PWA)
echo  ============================================
echo.

REM [STARTUP-2] unreachable (LAN_REFUSED above); a future LAN-AUTH-1 mode must reuse scripts/docteur-launch.mjs port checks

echo [1/4] Verification Ollama...
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I /N "ollama.exe" >NUL
if "%ERRORLEVEL%"=="0" (
    echo Ollama tourne deja.
) else (
    echo Lancement Ollama...
    start "Ollama" cmd /k "ollama serve"
    timeout /t 4 /nobreak >nul
)

echo.
echo [1b] Certificat HTTPS...
cd /d "%DOCTEUR_ROOT%"
node scripts/gen-cert.mjs
if errorlevel 1 (
    echo ERREUR : generation du certificat echouee.
    pause
    goto MENU
)

echo.
echo [2/4] Build de production en cours...
echo (peut prendre 10-20 secondes)
cd /d "%DOCTEUR_ROOT%"
call npm run build
if errorlevel 1 (
    echo ERREUR : le build a echoue. Verifier les erreurs ci-dessus.
    pause
    goto MENU
)
echo Build termine avec succes.

echo.
echo [3/4] Lancement du serveur cognitif (reseau local, port 3001)...
start "Cortex Server - Mobile" cmd /k "cd /d "%DOCTEUR_ROOT%\cortex-server" && npm run dev:local"
node scripts/wait-for-cortex.mjs
if errorlevel 1 goto MENU

echo.
echo [4/4] Lancement du serveur de production (port 5173)...
start "Docteur Preview - Mobile" cmd /k "cd /d "%DOCTEUR_ROOT%" && npm run preview:mobile"
timeout /t 4 /nobreak >nul

echo.
echo  ============================================
echo    Adresses IP du PC sur le reseau local :
echo  ============================================
ipconfig | findstr "192.168"
echo.
echo    Sur le telephone (meme Wi-Fi) :
echo    https://[adresse ci-dessus]:5173
echo.
echo    Certificat auto-signe : a la 1ere visite,
echo    Accepter le certificat : bouton Avance
echo    puis Continuer. Laisser charger completement.
echo    se charger completement.
echo    Visites suivantes : fonctionne hors-ligne.
echo.
echo    Garder les fenetres ouvertes.
echo  ============================================
echo.
timeout /t 5 /nobreak >nul
exit /b 0

REM ============================================================
:CHECK
REM  Lance check-docteur.bat si present
REM ============================================================
cls
echo.
if exist "%DOCTEUR_ROOT%\check-docteur.bat" (
    echo  Lancement de check-docteur.bat...
    echo.
    call "%DOCTEUR_ROOT%\check-docteur.bat"
    echo.
    pause
) else (
    echo  check-docteur.bat introuvable.
    echo  Placer check-docteur.bat a la racine du projet.
    echo.
    pause
)
goto MENU

REM ============================================================
:LAN_REFUSED
REM  [SEC-REMED-1 / SEC-2 + SEC-3] fail closed: nothing is started.
REM ============================================================
cls
echo.
echo  LAN_API_DISABLED_PENDING_AUTHENTICATION
echo.
echo  Les modes reseau (2) et mobile (3) sont desactives : l'API Docteur
echo  n'a pas encore d'authentification reseau (chantier LAN-AUTH-1).
echo  Sans elle, tout appareil du meme Wi-Fi pourrait lire vos donnees.
echo  Rien n'a ete demarre. Utilisez le mode PC (1).
echo.
pause
goto MENU

REM ============================================================
:STARTUP_STOPPED
REM  [STARTUP-1/2] any launch failure: Chrome is not opened, nothing is stopped, and the
REM  diagnostic printed above stays on screen (no cls on this path) until a key is pressed.
REM ============================================================
echo.
echo    Demarrage interrompu : Chrome n'a pas ete ouvert.
echo    Le diagnostic ci-dessus reste affiche ; appuyer sur une
echo    touche pour fermer cette fenetre.
echo.
pause
exit /b 1

REM ============================================================
:QUITTER
REM ============================================================
exit /b 0
