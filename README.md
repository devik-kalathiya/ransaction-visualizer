# TXN Studio – Transaction Visualizer

Express + SQLite backend that also serves the frontend (one service).

## Run locally
    cd backend
    cp .env.example .env      # add your GROQ_API_KEY
    npm install
    npm start
Open http://localhost:4000

## Deploy (e.g. Render)
- Root directory: `backend`
- Build command: `npm install`
- Start command: `npm start`
- Environment variables: GROQ_API_KEY, GROQ_MODEL, GROQ_FALLBACK_MODEL (PORT is set by the host)
- Node 18+ required. The SQLite database is created automatically on first start.
