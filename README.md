# Extraction Machine — Frontend

React + Vite frontend with two pages:

- `/` — Extraction Machine: pastes text into a numbers/dates/money extraction API.
- `/cities` — a proximity-graph visualization over a cities/borders API.

## Setup

```bash
npm install
cp .env.development.example .env.development
cp .env.production.example .env.production
```

Fill in `VITE_API_BASE` (extraction API) and `VITE_CITIES_API_BASE` (cities API) in both files
with your own deployed backend URLs.

## Run

```bash
npm run dev       # http://localhost:5173
npm run build      # outputs to dist/
npm run preview
```
