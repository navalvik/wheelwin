import { Config } from "@ton/blueprint";

/**
 * R7.66A — Blueprint config for WheelWin GameEscrow toolchain.
 * Network targets live in server/payment/ton/networks (runtime).
 */
export const config: Config = {
    recursiveWrappers: true,
    separateCompilables: true
};
