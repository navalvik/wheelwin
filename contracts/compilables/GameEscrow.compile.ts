import type { CompilerConfig } from "@ton/blueprint";

/**
 * R7.66B — Compile GameEscrow v1 (INIT_GAME + SETTLE).
 */
export const compile: CompilerConfig = {
    lang: "tact",
    target: "game_escrow/GameEscrow.tact",
    options: {
        debug: false
    }
};
