import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(testDirectory, "../pages/NoFriendsQueuePage.jsx"), "utf8");

assert.match(page, /insufficientBalance && <div className="noFriendsError" role="alert">/);
assert.match(page, /noFriends\.insufficientBalance\.body/);
assert.match(page, /!insufficientBalance && valid/);
assert.match(page, /setInsufficientBalance\(null\);/);
assert.doesNotMatch(page, /NoFriendsInsufficientBalanceOverlay|role="dialog"/);

process.stdout.write("noFriendsWalletBalance.render.test.js: all assertions passed\n");
