import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(resolve(sourceDirectory, "NoFriendsQueuePage.jsx"), "utf8");
const appSource = readFileSync(resolve(sourceDirectory, "../App.jsx"), "utf8");

assert.match(pageSource, /const QUEUE_EXPIRED_MESSAGE = "No players found\. Press FIND PLAYERS to search again\.";/,
    "queue expiry displays the requested retry message");
assert.match(pageSource, /const onExpired = \(\) => \{[\s\S]*?setChecking\(false\);[\s\S]*?setWaiting\(null\);[\s\S]*?setSeconds\(180\);[\s\S]*?setError\(QUEUE_EXPIRED_MESSAGE\);[\s\S]*?\};/,
    "expiry ends the previous wait, resets the timer, and keeps the page open");
assert.doesNotMatch(pageSource.match(/const onExpired = \(\) => \{[\s\S]*?\n        \};/)?.[0] ?? "",
    /onNavigate|setNickname|setAge|setWallet|setBaseStake/,
    "expiry neither navigates away nor clears entered profile values");
assert.match(pageSource, /const onMatched = \(\) => \{\s*matchedRef\.current = true;\s*onNavigate\(APP_PAGES\.NO_FRIENDS_OPTIONS\);/,
    "a successful match still proceeds to NO_FRIENDS_OPTIONS and blocks stale expiry");
assert.match(pageSource, /if \(matchedRef\.current\) return;/,
    "stale queue status or expiry is ignored after a successful match");
assert.match(pageSource, /socket\.emit\(LOBBY_OUTGOING_EVENTS\.NO_FRIENDS_REQUEST,\s*\{[\s\S]*?nickname: nickname\.trim\(\)\.slice\(0, 4\),[\s\S]*?age: numericAge,[\s\S]*?baseStake: Number\(baseStake\),[\s\S]*?wallet: wallet\.trim\(\)/,
    "repeat searches reuse the existing request and retained form values");
assert.match(pageSource, /nextEnabled=\{!waiting && !checking && valid\}/,
    "FIND PLAYERS is disabled while a search is active or being checked");
assert.match(pageSource, /\{error && <div className="noFriendsError">\{error\}<\/div>\}/,
    "the expiry message uses the existing in-form message area");

const navigatorSource = appSource.match(/function NoFriendsFlowNavigator\([\s\S]*?\n\}/)?.[0] ?? "";
assert.match(navigatorSource, /socket\.on\("noFriendsMatched", onMatched\)/,
    "the global navigator keeps the successful-match route");
assert.doesNotMatch(navigatorSource, /noFriendsQueueExpired|APP_PAGES\.WELCOME/,
    "queue expiry no longer globally redirects to WELCOME");

process.stdout.write("NoFriendsQueuePage.repeatSearch.test.js: all assertions passed\n");
