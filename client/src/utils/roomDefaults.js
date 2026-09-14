export const ROOM_DEFAULTS = {

    roomCreated: false,

    roomCode: "",

    connectedPlayers: 0,

    maxPlayers: 3,

    // R20 — authoritative room network ("testnet" | "mainnet"), null while
    // the owner's post-CREATE_ROOM network selection is pending.
    network: null

};