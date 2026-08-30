/**
 * Side-effect import: patch window.open before @tonconnect/ui-react loads.
 * Imported from main.jsx immediately after browser polyfills.
 */

import { installTelegramMiniAppGramWalletHandoff } from "./telegramMiniAppGramWalletHandoff.js";

installTelegramMiniAppGramWalletHandoff();
