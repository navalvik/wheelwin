import "./polyfills/browserPolyfills";

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { TonConnectUIProvider } from "@tonconnect/ui-react";
import { resolveTonConnectManifestUrl } from './payment/resolveTonConnectManifestUrl.js';

import App from "./App.jsx";

import socket from "./socket/socket";

import { devLog } from "./utils/devLog";


import "./styles/global.css";
import "./styles/layout.css";

socket.connect();

socket.on("connect", () => {

    devLog("Connected to server");

});

socket.on("disconnect", () => {

    devLog("Disconnected from server");

});

ReactDOM.createRoot(document.getElementById("root")).render(

    <React.StrictMode>

        <TonConnectUIProvider manifestUrl={resolveTonConnectManifestUrl(window.location.origin, import.meta.env.VITE_TONCONNECT_MANIFEST_URL)}>

            <BrowserRouter>

                <App />

            </BrowserRouter>

        </TonConnectUIProvider>

    </React.StrictMode>

);
