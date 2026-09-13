# WheelWin — Telegram Android CREATE ROOM Follow-up

## Objective
Resolve the remaining Mainnet Telegram Android CREATE_ROOM failure without weakening server-side Telegram authentication or changing the fail-closed CREATE_ROOM security model.

## Production evidence after the previous fix
The previous commit `552a496b88e83f5cdc5e6409e4fd19ccfed68445` was deployed to the client and the user retested Mainnet on Telegram Android.

Railway Mainnet recorded the Android Telegram WebView user agent and successful Socket.IO HTTP handshakes, followed by:

`Stage: CREATE_ROOM_AUTHORIZATION | Decision: REJECT | Reason: No authenticated Telegram identity on socket | Caller: RoomLobbyBridge._handleCreateRoom`

The same session therefore reached the server, but `socket.data.telegramUserId` was not established before CREATE_ROOM.

## Root-cause refinement
The previous fix handled the case where `window.Telegram.WebApp` exists before `initData` is populated. The new runtime evidence shows that this is not sufficient for the failing Android path: the client can still reach the socket handshake without an SDK-provided authenticated `initData`.

Telegram Mini Apps also carry the signed launch data as the `tgWebAppData` launch parameter. The production client therefore needs a narrowly scoped fallback: if the official SDK does not currently expose non-empty `WebApp.initData`, read `tgWebAppData` from the current URL query/hash and forward that raw value to the server. The server remains the sole authority for cryptographic validation.

## Implementation
`client/src/socket/socket.js` now:

- keeps `window.Telegram.WebApp.initData` as the primary source;
- falls back only to the `tgWebAppData` launch parameter in `location.search` or `location.hash` when the SDK value is empty;
- continues to generate Socket.IO auth dynamically for every connection/reconnect;
- allows the initial wait helper to recognize the URL launch-data fallback;
- never reads or sends `initDataUnsafe`;
- never logs, parses, or trusts the client-side identity;
- leaves server-side Telegram validation and CREATE_ROOM authorization unchanged.

## Tests
`client/src/socket/socket.telegramAuth.test.js` now verifies:

- exact SDK `initData` forwarding;
- delayed Android SDK `initData` capture;
- `tgWebAppData` URL fallback when the SDK object is absent;
- URL fallback is used in the Socket.IO auth callback;
- standard Web remains unauthenticated and is not artificially delayed;
- `initDataUnsafe` is never used;
- forbidden client secrets remain absent.

## Security boundary
This fallback does **not** authorize the client by itself. A browser can forge a URL fragment, so the value is treated only as a transport for the signed Telegram launch data. The existing server-side validator must still verify the signature, bot token, freshness, and resulting Telegram identity before CREATE_ROOM is accepted.

## Production validation required
After the new Vercel deployment is live:

1. Open the Mainnet Mini App in Telegram Android using the same normal launch path.
2. Reach Page2.
3. Press CREATE ROOM.
4. Confirm the room is created and a room ID appears.
5. Confirm Railway no longer records `CREATE_ROOM_AUTHORIZATION | REJECT | Reason: No authenticated Telegram identity on socket` for that Android attempt.

Do not consider the Android CREATE_ROOM issue closed until the live test succeeds.
