@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo.
echo ============================================================
echo   INSTALL DOCTEUR - Reinstallation sur machine neuve
echo ============================================================
echo.
echo   Ce script installe les dependances et telecharge les
echo   modeles IA necessaires au fonctionnement de Docteur.
echo.
echo   Prerequis a installer manuellement avant ce script :
echo     Node.js LTS   : https://nodejs.org/
echo     Ollama        : https://ollama.com/download
echo   Optionnel :
echo     Python 3.x    : https://python.org/  (Whisper local)
echo.

:: ================================================================
:: 1. VERIFICATION DES PREREQUIS
:: ================================================================

echo [1/5] Verification des prerequis...
echo.

set PREREQ_OK=1

where node >nul 2>&1
if !errorlevel! neq 0 (
  echo   [MANQUANT] Node.js non trouve.
  echo              Installer depuis : https://nodejs.org/
  set PREREQ_OK=0
) else (
  for /f "tokens=*" %%v in ('node --version 2^>nul') do echo   [OK] Node.js %%v
)

where npm >nul 2>&1
if !errorlevel! neq 0 (
  echo   [MANQUANT] npm non trouve (inclus normalement avec Node.js).
  set PREREQ_OK=0
) else (
  for /f "tokens=*" %%v in ('npm --version 2^>nul') do echo   [OK] npm %%v
)

where ollama >nul 2>&1
if !errorlevel! neq 0 (
  echo   [MANQUANT] Ollama non trouve.
  echo              Installer depuis : https://ollama.com/download
  set PREREQ_OK=0
) else (
  for /f "tokens=*" %%v in ('ollama --version 2^>nul') do echo   [OK] Ollama %%v
)

where python >nul 2>&1
if !errorlevel! equ 0 (
  for /f "tokens=*" %%v in ('python --version 2^>nul') do echo   [OK] Python %%v (Whisper local disponible)
) else (
  echo   [INFO] Python absent - Whisper local desactive, Groq Whisper reste utilisable.
  echo          Pour activer : https://python.org/
)

where git >nul 2>&1
if !errorlevel! equ 0 (
  for /f "tokens=*" %%v in ('git --version 2^>nul') do echo   [OK] %%v
)

echo.

if !PREREQ_OK! neq 1 (
  echo   ARRET : prerequis obligatoires manquants.
  echo   Installer Node.js et Ollama puis relancer ce script.
  echo.
  pause
  exit /b 1
)

:: ================================================================
:: 2. CONFIRMATION
:: ================================================================

echo [2/5] Actions qui vont etre effectuees :
echo.
echo   - npm install a la racine (frontend React/Vite)
echo   - npm install dans cortex-server/ (serveur Node/Hono)
echo   - npx playwright install chromium (capture profonde)
echo   - Creation des dossiers de donnees manquants
echo   - Telechargement des modeles Ollama absents (apres confirmation)
echo.
echo   Appuyer sur une touche pour continuer ou fermer la fenetre pour annuler.
pause >nul
echo.

:: ================================================================
:: 3. DEPENDANCES NPM
:: ================================================================

echo [3/5] Installation des dependances npm...
echo.

echo   [3.1] npm install (racine - frontend)...
call npm install 2>&1
if !errorlevel! neq 0 (
  echo.
  echo   [ERREUR] npm install (racine) a echoue.
  pause
  exit /b 1
)
echo   [OK] Frontend installe.
echo.

echo   [3.2] npm install (cortex-server - backend)...
pushd cortex-server
call npm install 2>&1
set SERVER_ERR=!errorlevel!
popd
if !SERVER_ERR! neq 0 (
  echo.
  echo   [ERREUR] npm install (cortex-server) a echoue.
  pause
  exit /b 1
)
echo   [OK] cortex-server installe.
echo.

echo   [3.3] npx playwright install chromium...
call npx playwright install chromium 2>&1
if !errorlevel! neq 0 (
  echo   [AVERT] Playwright Chromium non installe - capture profonde limitee.
  echo           Relancer manuellement : npx playwright install chromium
) else (
  echo   [OK] Playwright Chromium installe.
)
echo.

:: ================================================================
:: 4. DOSSIERS DE DONNEES
:: ================================================================

echo [4/5] Dossiers de donnees...
echo.

set DATA=cortex-server\data

call :mkd "%DATA%"
call :mkd "%DATA%\backups"
call :mkd "%DATA%\tmp"
call :mkd "%DATA%\images"
call :mkd "%DATA%\inbox"
call :mkd "%DATA%\inbox\traites"
call :mkd "%DATA%\inbox\erreurs"

echo.
echo   NOTE : les donnees (neurones, images, backups) ne sont PAS dans Git.
echo          Les restaurer manuellement depuis un backup JSON.
echo.

:: ================================================================
:: 5. MODELES OLLAMA
:: ================================================================

echo [5/5] Modeles Ollama...
echo.

:: Demarrer Ollama si non disponible
ollama list >nul 2>&1
if !errorlevel! neq 0 (
  echo   Demarrage du service Ollama...
  start /b "" ollama serve >nul 2>&1
  timeout /t 4 /nobreak >nul
)

:: Modeles requis :
::   nomic-embed-text : embeddings semantiques      ~274 MB
::   llama3.2:3b      : modele rapide / fallback    ~2.0 GB
::   qwen2.5:7b       : modele principal            ~4.7 GB
::
:: Modele optionnel :
::   qwen2.5:14b      : analyse CV, recherche       ~9.0 GB

echo   Etat des modeles :
echo.

set NEED_NOMIC=1
set NEED_LLAMA3=1
set NEED_QWEN7=1
set NEED_QWEN14=1
set MODELS_MISSING=0

ollama list 2>nul | findstr /i "nomic-embed-text" >nul 2>&1
if !errorlevel! equ 0 (
  echo   [INSTALLE] nomic-embed-text
  set NEED_NOMIC=0
) else (
  echo   [MANQUANT] nomic-embed-text   ~274 MB   - embeddings semantiques (requis)
  set MODELS_MISSING=1
)

ollama list 2>nul | findstr /i "llama3.2:3b" >nul 2>&1
if !errorlevel! equ 0 (
  echo   [INSTALLE] llama3.2:3b
  set NEED_LLAMA3=0
) else (
  echo   [MANQUANT] llama3.2:3b        ~2.0 GB   - modele rapide / fallback (requis)
  set MODELS_MISSING=1
)

ollama list 2>nul | findstr /i "qwen2.5:7b" >nul 2>&1
if !errorlevel! equ 0 (
  echo   [INSTALLE] qwen2.5:7b
  set NEED_QWEN7=0
) else (
  echo   [MANQUANT] qwen2.5:7b         ~4.7 GB   - modele principal (requis)
  set MODELS_MISSING=1
)

ollama list 2>nul | findstr /i "qwen2.5:14b" >nul 2>&1
if !errorlevel! equ 0 (
  echo   [INSTALLE] qwen2.5:14b (optionnel)
  set NEED_QWEN14=0
) else (
  echo   [ABSENT]   qwen2.5:14b        ~9.0 GB   - analyse CV, recherche (optionnel)
)

echo.

if !MODELS_MISSING! equ 0 (
  echo   Tous les modeles requis sont deja installes.
  goto :models_optional
)

echo   Des modeles requis sont absents.
echo   Les telecharger maintenant ? (connexion internet necessaire)
echo.
set /p PULL_CHOICE="   [o/n] > "
if /i not "!PULL_CHOICE!"=="o" (
  echo.
  echo   Telechargement ignore. Commandes pour plus tard :
  if !NEED_NOMIC! equ 1  echo     ollama pull nomic-embed-text
  if !NEED_LLAMA3! equ 1 echo     ollama pull llama3.2:3b
  if !NEED_QWEN7! equ 1  echo     ollama pull qwen2.5:7b
  goto :models_optional
)

echo.

if !NEED_NOMIC! equ 1 (
  echo   [PULL] nomic-embed-text ~274 MB ...
  ollama pull nomic-embed-text
  if !errorlevel! neq 0 (
    echo   [ERREUR] Echec - verifier la connexion reseau.
  ) else (
    echo   [OK] nomic-embed-text installe.
  )
  echo.
)

if !NEED_LLAMA3! equ 1 (
  echo   [PULL] llama3.2:3b ~2.0 GB - quelques minutes...
  ollama pull llama3.2:3b
  if !errorlevel! neq 0 (
    echo   [ERREUR] Echec du pull llama3.2:3b.
  ) else (
    echo   [OK] llama3.2:3b installe.
  )
  echo.
)

if !NEED_QWEN7! equ 1 (
  echo   [PULL] qwen2.5:7b ~4.7 GB - plusieurs minutes selon la connexion...
  ollama pull qwen2.5:7b
  if !errorlevel! neq 0 (
    echo   [ERREUR] Echec du pull qwen2.5:7b.
  ) else (
    echo   [OK] qwen2.5:7b installe.
  )
  echo.
)

:models_optional

if !NEED_QWEN14! equ 1 (
  echo   qwen2.5:14b (optionnel) non installe.
  echo   Utile pour : analyse CV avancee, recherches complexes.
  echo   Poids : ~9.0 GB - requiert ~12 GB de RAM/VRAM disponible.
  echo.
  set /p PULL14_CHOICE="   Installer qwen2.5:14b maintenant ? [o/n] > "
  if /i "!PULL14_CHOICE!"=="o" (
    echo   [PULL] qwen2.5:14b ~9.0 GB - peut prendre 10 a 20 minutes...
    ollama pull qwen2.5:14b
    if !errorlevel! equ 0 (
      echo   [OK] qwen2.5:14b installe.
    ) else (
      echo   [AVERT] Echec - installer manuellement plus tard : ollama pull qwen2.5:14b
    )
  ) else (
    echo   Pour plus tard : ollama pull qwen2.5:14b
  )
  echo.
)

:: ================================================================
:: VERIFICATION FINALE
:: ================================================================

echo.
echo ============================================================
echo   VERIFICATION FINALE
echo ============================================================
echo.

if exist "check-docteur.bat" (
  echo   Lancement de check-docteur.bat...
  echo.
  call check-docteur.bat
  echo.
) else (
  echo   check-docteur.bat introuvable - verification ignoree.
  echo.
)

echo ============================================================
echo   ETAPES MANUELLES RESTANTES
echo ============================================================
echo.
echo   1. RESTAURER LES DONNEES (prioritaire)
echo      - Copier un backup JSON dans cortex-server\data\backups\
echo      - Demarrer Docteur puis :
echo          Parametres > Sauvegardes > Restaurer un backup
echo      - Copier egalement cortex-server\data\images\ si des images ont ete
echo        inserees dans les neurones
echo.
echo   2. CLES CLOUD (optionnel)
echo      Parametres > Fournisseurs cloud
echo      - Gemini (Google AI Studio) : veille, synthese, grounding Google Search
echo      - Groq : transcription Whisper rapide
echo      - OpenRouter / Anthropic : modeles alternatifs
echo.
echo   3. CERTIFICATS HTTPS (si acces mobile sur reseau local)
echo      - Generer : node scripts\gen-cert.mjs
echo      - Installer le certificat sur le telephone (voir README)
echo      - Utiliser start-mobile.bat
echo.
echo   4. LANCER DOCTEUR
echo      Mode local  : start-local.bat
echo      Mode mobile : start-mobile.bat
echo      Manuellement :
echo        Terminal 1 : cd cortex-server  puis  node src/server.js
echo        Terminal 2 : npm run dev
echo.
echo ============================================================
echo   Installation terminee.
echo ============================================================
echo.

endlocal
pause
exit /b 0

:: ================================================================
:: Sous-routine : creer un dossier s'il n'existe pas
:: ================================================================
:mkd
  if not exist %~1 (
    mkdir %~1
    echo   [CREE]   %~1
  ) else (
    echo   [OK]     %~1
  )
exit /b 0
