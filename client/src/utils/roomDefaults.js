export const ROOM_DEFAULTS = {

    roomCreated: false,

    roomCode: "",

    connectedPlayers: 0,

    maxPlayers: 3,

    // R24.1 — authoritative room network. null until the room Owner commits
    // the one-time Testnet/Mainnet selection server-side.
    network: null,

    // R24.1 — authoritative room Owner projection (playerId). Lets the
    // creator's UI re-derive ownership after roomState hydration.
    ownerPlayerId: null

};