import type { CompilerConfig } from "@ton/blueprint";

/**
 * R7.66C — Compile GameEscrow v1 with SETTLE payouts.
 */
export const compile: CompilerConfig = {
    lang: "tact",
    target: "game_escrow/GameEscrow.tact",
    options: {
        debug: false
    }
};
