/**
 * R6.6A — Browser globals required by Node-oriented packages (@ton/core).
 * Imported once from main.jsx before React mounts.
 */

import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {

    globalThis.Buffer = Buffer;

}
