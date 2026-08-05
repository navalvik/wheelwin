const fs = require("fs");

function checkBalance(path) {
    const s = fs.readFileSync(path, "utf8");
    let p = 0;
    let b = 0;
    let c = 0;
    let inS = false;
    let inD = false;
    let inT = false;
    let inLC = false;
    let inBC = false;
    let esc = false;

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        const n = s[i + 1];

        if (inLC) {
            if (ch === "\n") inLC = false;
            continue;
        }
        if (inBC) {
            if (ch === "*" && n === "/") {
                inBC = false;
                i++;
            }
            continue;
        }
        if (inS || inD || inT) {
            if (esc) {
                esc = false;
                continue;
            }
            if (ch === "\\") {
                esc = true;
                continue;
            }
            if (inS && ch === "'") inS = false;
            else if (inD && ch === '"') inD = false;
            else if (inT && ch === "`") inT = false;
            continue;
        }
        if (ch === "/" && n === "/") {
            inLC = true;
            i++;
            continue;
        }
        if (ch === "/" && n === "*") {
            inBC = true;
            i++;
            continue;
        }
        if (ch === "'") {
            inS = true;
            continue;
        }
        if (ch === '"') {
            inD = true;
            continue;
        }
        if (ch === "`") {
            inT = true;
            continue;
        }
        if (ch === "(") p++;
        else if (ch === ")") p--;
        if (ch === "[") b++;
        else if (ch === "]") b--;
        if (ch === "{") c++;
        else if (ch === "}") c--;
        if (p < 0 || b < 0 || c < 0) {
            console.log(path + " NEGATIVE at", i);
            return;
        }
    }
    console.log(path, { parens: p, brackets: b, braces: c });
}

checkBalance("g:/WheelWin/client/src/pages/Page4Payment.jsx");
checkBalance("g:/WheelWin/client/src/console/panels/TonConnectDiagnosticsPanel.jsx");
checkBalance("g:/WheelWin/client/src/diagnostics/tonConnectAutopsy.js");
