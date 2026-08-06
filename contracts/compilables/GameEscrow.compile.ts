import type { CompilerConfig } from "@ton/blueprint";

/**
 * R7.66A — Compile GameEscrow Tact skeleton (no escrow logic yet).
 */
export const compile: CompilerConfig = {
    lang: "tact",
    target: "game_escrow/GameEscrow.tact",
    options: {
        debug: false
    }
};
