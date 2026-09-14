import "./polyfills/browserPolyfills";
import "./tonconnect/installTelegramMiniAppGramWalletHandoff.js";

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { TonConnectUIProvider } from "@tonconnect/ui-react";

import App from "./App.jsx";

import socket, {
    getTelegramInitDiagnostics,
    waitForTelegramInitData
} from "./socket/socket";

import { devLog } from "./utils/devLog";

import { resolveTonConnectManifestUrl } from "./config/tonConnectManifest.js";

import "./styles/global.css";
import "./styles/layout.css";

const connectSocket = async () => {

    const telegramInitData = await waitForTelegramInitData();

    if (!telegramInitData) {

        const diagnostics = getTelegramInitDiagnostics();

        if (diagnostics.runtimeDetected) {

            console.warn(
                "WheelWin Telegram initData is empty",
                diagnostics
            );

            const showAlert = window.Telegram?.WebApp?.showAlert;

            if (typeof showAlert === "function") {

                showAlert(
                    [
                        "WheelWin Telegram diagnostics",
                        `platform=${diagnostics.platform || "unknown"}`,
                        `webApp=${diagnostics.webAppPresent ? "yes" : "no"}`,
                        `initData=${diagnostics.webAppInitDataPresent ? "yes" : "no"}`,
                        `urlData=${diagnostics.urlInitDataPresent ? "yes" : "no"}`,
                        `webViewParams=${diagnostics.webViewInitParamsPresent ? "yes" : "no"}`,
                        `webViewData=${diagnostics.webViewInitDataPresent ? "yes" : "no"}`,
                        `proxy=${diagnostics.telegramWebviewProxyPresent ? "yes" : "no"}`,
                        `postEvent=${diagnostics.webViewPostEventPresent ? "yes" : "no"}`,
                        `sessionParams=${diagnostics.sessionStorageInitParamsPresent ? "yes" : "no"}`
                    ].join("\n")
                );

            }

        }

    }

    socket.connect();

};

void connectSocket();

socket.on("connect", () => {

    devLog("Connected to server");

});

socket.on("disconnect", () => {

    devLog("Disconnected from server");

});

const tonConnectManifestUrl = resolveTonConnectManifestUrl();

ReactDOM.createRoot(document.getElementById("root")).render(

    <React.StrictMode>

        <TonConnectUIProvider manifestUrl={tonConnectManifestUrl}>

            <BrowserRouter>

                <App />

            </BrowserRouter>

        </TonConnectUIProvider>

    </React.StrictMode>

);
