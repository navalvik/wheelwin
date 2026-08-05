const cp = require("child_process");
const fs = require("fs");

const root = "G:/WheelWin/server";

const files = cp
  .execSync(`rg --files ${root} -g"*.js" -g"*.jsx"`, { encoding: "utf8" })
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);

// Extract only numeric literals (ms) from the first delay argument:
// setTimeout(fn, 1234)
// setInterval(fn, 1000)
// Ignores computed expressions.
const reTimeout = /setTimeout\([^,\n]*,\s*([0-9][0-9_]*)/g;
const reInterval = /setInterval\([^,\n]*,\s*([0-9][0-9_]*)/g;

const norm = (n) => String(n).replace(/_/g, "");

const timeouts = new Set();
const intervals = new Set();

for (const f of files) {
  let txt;
  try {
    txt = fs.readFileSync(f, "utf8");
  } catch {
    continue;
  }

  let m;
  reTimeout.lastIndex = 0;
  while ((m = reTimeout.exec(txt))) {
    timeouts.add(Number(norm(m[1])));
  }

  reInterval.lastIndex = 0;
  while ((m = reInterval.exec(txt))) {
    intervals.add(Number(norm(m[1])));
  }
}

const allTimeouts = [...timeouts].sort((a, b) => a - b);
const allIntervals = [...intervals].sort((a, b) => a - b);

const inRange = allTimeouts.filter((v) => v >= 500 && v <= 1500);

console.log(JSON.stringify({
  timeoutCount: allTimeouts.length,
  timeouts: allTimeouts,
  intervalCount: allIntervals.length,
  intervals: allIntervals,
  timeoutInRangeCount: inRange.length,
  timeoutInRange: inRange
}, null, 2));

