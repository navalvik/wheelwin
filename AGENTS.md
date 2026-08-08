# WheelWin

WheelWin is a 3-player, TON-blockchain wheel game. The repo has three independent
npm projects:

- `client/` — React 19 + Vite single-page app (dev server on port `5173`).
- `server/` — Node.js (ESM) Express + Socket.IO authoritative game server (port `3001`). Entry point is `app.js` (`server/index.js` is an unused stub).
- `contracts/` — TON smart contract (`GameEscrow`) written in Tact, built/tested with `@ton/blueprint` + Jest.

See `PROJECT_FLOW.md` for the gameplay screen flow (Welcome → Room Lobby → Player Setup → Verify → Payment → Wheel → Result).

## Cursor Cloud specific instructions

Dependencies (three separate `npm install`s) and the two required gitignored config
files are handled by the startup update script, so you normally do not need to run
them manually.

### Services and how to run them

- Backend: `npm --prefix server run dev` (nodemon `app.js`). Listens on `http://localhost:3001`. Health check: `curl http://localhost:3001/health`. Root `GET /` returns `WheelWin Server Running`.
- Frontend: `npm --prefix client run dev` (Vite). Serves `http://localhost:5173`. The browser client auto-connects to the backend at the page host on port `3001` (see `client/src/config/backendUrl.js`); override with `VITE_SOCKET_URL` if needed. No client `.env` is required for local dev.
- Run both together for an end-to-end game (Socket.IO). CORS on the server allows `http://localhost:5173` via `CLIENT_ORIGIN` in `server/.env`.

### Required config (gitignored, created from committed examples)

- `server/.env` — copied from `server/.env.example`. Defaults are development-ready (`NODE_ENV=development`, `TON_NETWORK=testnet`, `TON_DEPLOY_MODE=stub`); no real TON keys needed to boot or to create/join rooms locally.
- `config/owner.json` — copied from `config/owner.example.json`. The server refuses to start without it (or without `OWNER_WALLET` set in the environment). The example placeholder wallet is fine for local dev.

### Lint / test / build

- Client lint: `npm --prefix client run lint`. Note: the committed source currently has pre-existing ESLint errors; the linter itself works, so a non-zero exit here is expected and not an environment problem.
- Contracts test: `npm --prefix contracts test` compiles the Tact contract (writes a BOC artifact into `server/payment/ton/artifacts/`) and runs Jest — all pass.
- Server tests: `npm --prefix server test` and client tests: `npm --prefix client test` use a custom runner (`scripts/run-tests.js`) that stops at the first failing file. Some committed tests currently fail on their own assertions (pre-existing, not environment-related); the runners themselves work.
- Production/build commands (`server: npm start`, `client: npm run build`) exist but development uses the `dev` scripts above.

### Gotchas

- The server is authoritative and needs a full 3-player room to play a game to completion; a single browser can create/join a room (server generates a 4-char Room ID) but the wheel game requires all 3 seats filled.
- `server/hang-trace*.txt`, `server/server_log.txt` are committed debug scratch files from prior investigations; ignore them.
