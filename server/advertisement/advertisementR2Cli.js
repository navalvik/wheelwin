/**
 * R16.8 — Child-process CLI for synchronous AdvertisementStorage → R2 bridge.
 */

import { executeAdvertisementR2Command } from "./advertisementR2Commands.js";

const command = process.argv[2];
const inputJson = process.argv[3] || "{}";

try {

    const input = JSON.parse(inputJson);
    const result = await executeAdvertisementR2Command(command, input);

    if (Buffer.isBuffer(result)) {

        process.stdout.write(JSON.stringify({
            ok: true,
            resultBase64: result.toString("base64")
        }));

    } else {

        process.stdout.write(JSON.stringify({
            ok: true,
            result
        }));

    }

} catch (error) {

    process.stdout.write(JSON.stringify({
        ok: false,
        error: error?.message || String(error)
    }));
    process.exit(1);

}
