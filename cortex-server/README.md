# Cortex Server

Serveur cognitif autonome de Docteur pour l'indexation vectorielle, la recherche semantique et le RAG local via Ollama.

## Prerequis

- Node.js 20 ou plus
- Ollama installe et en marche sur Windows
- Les modeles suivants disponibles dans Ollama :
  - `nomic-embed-text`
  - `llama3.2:3b`

## Installation

1. Ouvre un terminal dans `cortex-server`.
2. Installe les dependances :

```bash
npm install
```

3. Copie la configuration exemple :

```bash
copy .env.example .env
```

## Demarrage

### Mode developpement

```bash
npm run dev
```

### Mode production

```bash
npm start
```

### Double-clic Windows

Lance `start.bat` dans le dossier `cortex-server`.

## Configuration

Les variables suivantes sont lues depuis `.env` :

- `PORT=3001`
- `HOST=127.0.0.1`
- `OLLAMA_URL=http://localhost:11434`
- `EMBEDDING_MODEL=nomic-embed-text`
- `ANSWER_MODEL=llama3.2:3b`
- `LANCEDB_PATH=./data/cortex.lance`
- `SQLITE_PATH=./data/cortex.sqlite`
- `LOG_LEVEL=info`
- `LOG_FILE=./data/cortex.log`

## Verification rapide

Le check de configuration verifie Ollama et la presence des modeles sans demarrer le serveur :

```bash
npm run check
```

## Endpoints

### `GET /api/health`

Retourne l'etat global du serveur, la connexion Ollama, les modeles detectes et le nombre de neurones indexes.

Exemple :

```bash
curl http://localhost:3001/api/health
```

### `POST /api/index`

Indexe ou remplace un neurone.

```bash
curl -X POST http://localhost:3001/api/index -H "Content-Type: application/json" -d "{\"id\":\"test1\",\"kind\":\"note\",\"title\":\"Mot de passe wifi\",\"content\":\"Mon code wifi maison est papillon42\"}"
```

### `POST /api/search`

Recherche semantique.

```bash
curl -X POST http://localhost:3001/api/search -H "Content-Type: application/json" -d "{\"query\":\"code wifi\"}"
```

### `POST /api/answer`

Question RAG avec synthese par LLM.

```bash
curl -X POST http://localhost:3001/api/answer -H "Content-Type: application/json" -d "{\"question\":\"quel est mon code wifi ?\"}"
```

### `DELETE /api/neuron/:id`

Supprime un neurone de l'index.

```bash
curl -X DELETE http://localhost:3001/api/neuron/test1
```

## Workflow de test demande

1. Verifier la sante :

```bash
curl http://localhost:3001/api/health
```

2. Indexer un premier neurone :

```bash
curl -X POST http://localhost:3001/api/index -H "Content-Type: application/json" -d "{\"id\":\"test1\",\"kind\":\"note\",\"title\":\"Mot de passe wifi\",\"content\":\"Mon code wifi maison est papillon42\"}"
```

3. Indexer un second neurone :

```bash
curl -X POST http://localhost:3001/api/index -H "Content-Type: application/json" -d "{\"id\":\"test2\",\"kind\":\"note\",\"title\":\"Recette carbonara\",\"content\":\"Pates carbonara : oeufs, guanciale, pecorino, poivre. Jamais de creme.\"}"
```

4. Lancer une recherche semantique :

```bash
curl -X POST http://localhost:3001/api/search -H "Content-Type: application/json" -d "{\"query\":\"code wifi\"}"
```

5. Poser une question en RAG :

```bash
curl -X POST http://localhost:3001/api/answer -H "Content-Type: application/json" -d "{\"question\":\"quel est mon code wifi ?\"}"
```

## Troubleshooting

### Ollama est down

- Verifie que le service Ollama tourne bien sur le port configure.
- Releve l'URL dans `.env` et compare-la avec `OLLAMA_URL`.
- Le serveur renvoie alors `503` avec un message explicite, sans planter.

### Port deja occupe

- Change `PORT` dans `.env`.
- Verifie qu'aucun autre processus n'utilise le port `3001`.

### Modele manquant

- Installe les modeles requis dans Ollama :

```bash
ollama pull nomic-embed-text
ollama pull llama3.2:3b
```

### Index vide

- Lance d'abord `POST /api/index` sur quelques neurones.
- Ensuite `POST /api/search` et `POST /api/answer` auront du contexte exploitable.
