# WheelWin — Telegram Android CREATE ROOM Fix

## Objective
Make authenticated room creation work in Telegram Android without weakening server-side Telegram authorization or changing the CREATE_ROOM security model.

## Confirmed runtime evidence
Railway Mainnet production logs recorded an Android Telegram Mini App session and then a CREATE_ROOM authorization decision:

`Stage: CREATE_ROOM_AUTHORIZATION | Decision: REJECT | Reason: No authenticated Telegram identity on socket | Caller: RoomLobbyBridge._handleCreateRoom`

The Android Socket.IO HTTP handshake requests themselves returned HTTP 200, but the server-side socket had no authenticated Telegram identity when CREATE_ROOM was requested.

## Confirmed client-side cause
The client previously captured `window.Telegram.WebApp.initData` once when `socket.js` was imported and stored that value permanently in `socket.auth`. `main.jsx` then connected the socket immediately. This allowed an Android Mini App lifecycle in which the WebApp object existed before raw `initData` was populated to create an unauthenticated socket. Reconnects also reused the captured value.

## Fix
- Socket.IO auth is now generated through an auth callback, so raw Telegram `initData` is read for each connection attempt/reconnect.
- The client now waits briefly for Telegram Mini App `initData` before the initial socket connection when it is running inside an actual Telegram Mini App runtime.
- Standard browser access is not artificially delayed.
- The raw `initData` is still forwarded verbatim; it is not parsed, logged, or replaced with `initDataUnsafe` data.
- Server-side Telegram identity authorization and fail-closed CREATE_ROOM behavior are unchanged.

## Tests
Focused client authentication test updated to verify:
- exact raw initData is used;
- auth is generated dynamically;
- delayed Android initData is captured;
- standard Web is not delayed;
- reconnect-safe auth configuration remains in place;
- forbidden secrets remain absent from client source.

The test/build could not be executed through the GitHub connector. It must be run after synchronization to `G:\WheelWin` or by CI.

## Commit
Commit message: `fix: authenticate Telegram Android socket before room creation`

## Production validation required
After Vercel deploy, test the Mainnet Mini App on Telegram Android:
1. Open the Mainnet Mini App.
2. Reach Page2.
3. Press CREATE ROOM.
4. Confirm a room is created and the room ID is displayed.

Do not consider this runtime issue closed until that Android test succeeds.
