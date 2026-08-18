import type { CompilerConfig } from "@ton/blueprint";

/**
 * R17.9L.11 — Compile DepositContract v1 (immutable three-seat deposit escrow).
 */
export const compile: CompilerConfig = {
    lang: "tact",
    target: "deposit/DepositContract.tact",
    options: {
        debug: false
    }
};
