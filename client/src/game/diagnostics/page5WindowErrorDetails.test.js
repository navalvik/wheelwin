import assert from "node:assert/strict";
import { buildPage5WindowErrorDiagnostic } from "./page5WindowErrorDetails.js";

const diagnostic = buildPage5WindowErrorDiagnostic({
    error: {
        name: "TypeError",
        message: "Cannot read property (token=message-secret)",
        stack: "TypeError: failed\n at render (https://app.test/a.js?api_key=stack-secret:12:4)"
    },
    filename: "https://user:file-secret@app.test/a.js?access_token=query-secret",
    lineno: 12,
    colno: 4
}, {
    gameState: "PRE_GAME_READY",
    clock: { phase: "PRE_GAME_READY" }
});

assert.equal(diagnostic.kind, "client_error");
assert.equal(diagnostic.reason, "window_error");
assert.equal(diagnostic.errorName, "TypeError");
assert.equal(diagnostic.phase, "PRE_GAME_READY");
assert.equal(diagnostic.displayedPhase, "PRE_GAME_READY");
assert.equal(diagnostic.errorLine, 12);
assert.equal(diagnostic.errorColumn, 4);
assert.match(diagnostic.errorMessage, /Cannot read property/);
assert.match(diagnostic.errorStack, /render/);
assert.match(diagnostic.errorFile, /a\.js/);
for (const value of [diagnostic.errorMessage, diagnostic.errorStack, diagnostic.errorFile]) {
    assert.doesNotMatch(value, /message-secret|stack-secret|file-secret|query-secret/);
}

assert.equal(diagnostic.errorStack.length <= 2048, true);
assert.equal(diagnostic.errorMessage.length <= 512, true);
assert.equal(diagnostic.errorFile.length <= 256, true);

const partial = buildPage5WindowErrorDiagnostic({ message: "Script error." }, null);
assert.equal(partial.errorName, "Unknown");
assert.equal(partial.errorMessage, "Script error.");
assert.equal(partial.errorStack, null);
assert.equal(partial.phase, null);

console.log("page5WindowErrorDetails.test.js: all assertions passed");
