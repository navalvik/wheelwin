import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(testDirectory, "../..");
const vite = await createServer({
    root: clientRoot,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error"
});

try {
    const [
        { Page1AdvertisingContact },
        { default: InfoMenu },
        { LanguageProvider },
        { DOCUMENTS }
    ] = await Promise.all([
        vite.ssrLoadModule(resolve(clientRoot, "src/pages/Page1Welcome.jsx")),
        vite.ssrLoadModule(resolve(clientRoot, "src/components/InfoMenu.jsx")),
        vite.ssrLoadModule(resolve(clientRoot, "src/context/LanguageContext.jsx")),
        vite.ssrLoadModule(resolve(clientRoot, "src/utils/documents.js"))
    ]);

    const contactMarkup = renderToString(createElement(Page1AdvertisingContact));
    assert.match(contactMarkup, /Advertising &amp; Partnerships/);
    assert.match(
        contactMarkup,
        /<a href="mailto:advertising\.wheelwin@outlook\.com">\s*advertising\.wheelwin@outlook\.com\s*<\/a>/
    );

    let menuElement;
    let selectedItem = null;
    function CaptureInfoMenu() {
        menuElement = InfoMenu({
            activeItem: DOCUMENTS.WELCOME,
            onSelect(item) { selectedItem = item; }
        });
        return menuElement;
    }

    renderToString(createElement(
        LanguageProvider,
        null,
        createElement(CaptureInfoMenu)
    ));

    const advertisingTab = menuElement.props.children.find((button) => (
        button?.key === DOCUMENTS.ADVERTISING
    ));
    assert.ok(advertisingTab, "Page1 menu contains the advertising tab");
    assert.equal(advertisingTab.props.children, "Advertising & Partnerships");
    advertisingTab.props.onClick();
    assert.equal(selectedItem, DOCUMENTS.ADVERTISING);

    const pageSource = readFileSync(resolve(clientRoot, "src/pages/Page1Welcome.jsx"), "utf8");
    assert.match(
        pageSource,
        /activeItem === DOCUMENTS\.ADVERTISING[\s\S]*?<Page1AdvertisingContact\s*\/>/
    );

    const panelStyles = readFileSync(resolve(clientRoot, "src/styles/infoPanel.css"), "utf8");
    assert.match(panelStyles, /\.advertisingContact\s*\{[\s\S]*?display:flex;[\s\S]*?overflow-wrap:anywhere;/);
    assert.match(panelStyles, /\.advertisingContact a\s*\{[\s\S]*?max-width:100%;[\s\S]*?overflow-wrap:anywhere;/);
    assert.match(panelStyles, /\.infoPanelContent\s*\{[\s\S]*?overflow:auto;/);

    const menuStyles = readFileSync(resolve(clientRoot, "src/styles/infoMenu.css"), "utf8");
    assert.match(menuStyles, /\.infoMenu\s*\{[\s\S]*?overflow-y:auto;/);
} finally {
    await vite.close();
}

process.stdout.write("Page1Welcome.advertising.test.js: all assertions passed\n");
