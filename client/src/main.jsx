import "./polyfills/browserPolyfills";
import "./tonconnect/installTelegramMiniAppGramWalletHandoff.js";

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { TonConnectUIProvider } from "@tonconnect/ui-react";

import App from "./App.jsx";

import socket from "./socket/socket";

import { devLog } from "./utils/devLog";

import { resolveTonConnectManifestUrl } from "./config/tonConnectManifest.js";

import "./styles/global.css";
import "./styles/layout.css";

socket.connect();

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
