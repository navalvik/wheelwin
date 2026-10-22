/**
 * Manual diagnostic entrypoint; must never be wired to startup or gameplay.
 * Only logs fixed statuses, never sensitive provider bodies or API credentials.
 */
import { runGramTestnetGetterSmoke } from "./GramTestnetGetterSmoke.js";

try {
    await runGramTestnetGetterSmoke({ report: message => console.log(message) });
    console.log("Read-only Testnet getter diagnostic passed; payments remain disabled.");
} catch {
    console.error("Read-only Testnet getter diagnostic failed. No payment state was changed.");
    process.exitCode = 1;
}
