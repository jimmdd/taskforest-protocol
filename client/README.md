# TaskForest Devnet Client

Simple React UI for interacting with TaskForest transactions on Solana devnet.

## What this client does

- Creates/loads a local burner keypair in browser storage.
- Requests devnet airdrops.
- Sends a memo transaction (connectivity smoke test).
- Sends a self-transfer transaction (fee + signing smoke test).
- Builds and submits TaskForest `create_job` instruction payloads.

## Run locally

```bash
npm install
npm run dev
```

Open the URL shown by Vite (usually `http://localhost:5173`).

## Build

```bash
npm run build
```

## Notes

- Network is hardcoded to Solana `devnet`.
- Default program id is `11111111111111111111111111111111` (placeholder).
- Replace Program ID in UI with your deployed TaskForest program when ready.
- Burner keypair is stored in `localStorage` key: `taskforest_burner_secret_key`.
