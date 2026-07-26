import { io } from "socket.io-client";

import { resolveBackendUrl } from "../config/backendUrl.js";

const SOCKET_URL = resolveBackendUrl();

const socket = io(SOCKET_URL, {

    autoConnect: false,

    reconnection: true,

    reconnectionAttempts: Infinity,

    reconnectionDelay: 1000,

    reconnectionDelayMax: 5000

});

export default socket;
