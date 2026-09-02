@echo off
chcp 65001 >nul 2>&1
cd /d C:\dev\Docteur

:MENU
cls
echo.
echo  ============================================
echo    DOCTEUR - LANCEUR
echo  ============================================
echo.
echo    [1]  Mode PC (local)
echo         Usage quotidien sur cet ordinateur
echo         http://localhost:5173
echo.
echo    [2]  Mode reseau (dev)
echo         Acces depuis un autre poste, sans PWA
echo         http://IP:5173
echo.
echo    [3]  Mode mobile (PWA + hors-ligne)
echo         Pour le telephone : build + HTTPS + SW
echo         https://IP:5173
echo.
echo    [4]  Verification du projet
echo         Lance check-docteur.bat si present
echo.
echo    [0]  Quitter
echo.
set "CHOICE="
set /p CHOICE=   Choix :

if "%CHOICE%"=="1" goto MODE_PC
if "%CHOICE%"=="2" goto MODE_RESEAU
if "%CHOICE%"=="3" goto MODE_MOBILE
if "%CHOICE%"=="4" goto CHECK
if "%CHOICE%"=="0" goto QUITTER

echo.
echo    Choix invalide. Entrer 0, 1, 2, 3 ou 4.
echo.
pause
goto MENU

REM ============================================================
:MODE_PC
REM  Mode dev local -- exactement comme Docteur.bat (bureau)
REM  Ollama + cortex-server (npm run dev) + frontend (npm run dev)
REM  + Chrome --app http://localhost:5173
REM ============================================================
cls
echo.
echo  ============================================
echo    DOCTEUR - Mode PC local
echo  ============================================
echo.

call :FREE_PORTS

echo [1/3] Verification Ollama...
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I /N "ollama.exe" >NUL
if "%ERRORLEVEL%"=="0" (
    echo Ollama tourne deja.
) else (
    echo Lancement Ollama...
    start "Ollama" cmd /k "ollama serve"
    timeout /t 4 /nobreak >nul
)

echo [2/3] Lancement du serveur cognitif...
start "Cortex Server" cmd /k "cd /d C:\dev\Docteur\cortex-server && npm run dev"
timeout /t 3 /nobreak >nul

echo [3/3] Lancement du frontend...
start "Docteur Frontend" cmd /k "cd /d C:\dev\Docteur && npm run dev"
timeout /t 5 /nobreak >nul

echo Ouverture de Chrome...
start chrome --app=http://localhost:5173 2>nul
if errorlevel 1 (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:5173
)

echo.
echo  ============================================
echo    Lance en mode PC local
echo    http://localhost:5173
echo    Garder les fenetres ouvertes.
echo  ============================================
echo.
timeout /t 3 /nobreak >nul
exit /b 0

REM ============================================================
:MODE_RESEAU
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

call :FREE_PORTS

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
start "Cortex Server - Local Network" cmd /k "cd /d C:\dev\Docteur\cortex-server && npm run dev:local"
timeout /t 5 /nobreak >nul

echo [3/3] Lancement du frontend (HTTP, sans SW)...
start "Docteur Frontend - Local Network" cmd /k "cd /d C:\dev\Docteur && npm run dev:local"
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

call :FREE_PORTS

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
cd /d C:\dev\Docteur
node scripts/gen-cert.mjs
if errorlevel 1 (
    echo ERREUR : generation du certificat echouee.
    pause
    goto MENU
)

echo.
echo [2/4] Build de production en cours...
echo (peut prendre 10-20 secondes)
cd /d C:\dev\Docteur
call npm run build
if errorlevel 1 (
    echo ERREUR : le build a echoue. Verifier les erreurs ci-dessus.
    pause
    goto MENU
)
echo Build termine avec succes.

echo.
echo [3/4] Lancement du serveur cognitif (reseau local, port 3001)...
start "Cortex Server - Mobile" cmd /k "cd /d C:\dev\Docteur\cortex-server && npm run dev:local"
timeout /t 5 /nobreak >nul

echo.
echo [4/4] Lancement du serveur de production (port 5173)...
start "Docteur Preview - Mobile" cmd /k "cd /d C:\dev\Docteur && npm run preview:mobile"
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
if exist "C:\dev\Docteur\check-docteur.bat" (
    echo  Lancement de check-docteur.bat...
    echo.
    call "C:\dev\Docteur\check-docteur.bat"
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
:QUITTER
REM ============================================================
exit /b 0

REM ============================================================
:FREE_PORTS
REM  Tue un eventuel processus residuel occupant les ports 5173
REM  ou 3001 (Vite/cortex-server pas correctement fermes lors
REM  d'une session precedente). Ne cible QUE ces deux ports
REM  precis, via leur PID exact trouve par netstat -- jamais de
REM  taskkill par nom de process ou plage de ports.
REM ============================================================
for %%P in (5173 3001) do (
    for /f "tokens=5" %%I in ('netstat -ano ^| findstr /R /C:"[:.]%%P .*LISTENING"') do (
        echo Processus residuel detecte sur le port %%P, arret en cours...
        taskkill /PID %%I /F >nul 2>&1
    )
)
exit /b 0
