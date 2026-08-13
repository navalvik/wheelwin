/**
 * R6.6 / R17.1 — UI string catalogs keyed by language code.
 * English is the complete source of truth for player-facing UI.
 * Add a new object under TRANSLATIONS to support another language.
 */
export const TRANSLATIONS = Object.freeze({
    en: Object.freeze({
        "common.next": "NEXT",
        "common.back": "BACK",
        "common.finish": "FINISH",
        "common.loadingDocument": "Loading document...",
        "common.documentNotFound": "Document not found.",
        "common.language": "Language",
        "common.waiting": "Waiting",
        "common.icon": "ICON",
        "common.status": "Status",
        "common.wallet": "Wallet",
        "common.copy": "Copy",
        "common.copied": "Copied",

        "menu.welcome": "WELCOME",
        "menu.rules": "RULES",
        "menu.faq": "FAQ",
        "menu.privacy": "PRIVACY",
        "menu.terms": "TERMS",
        "menu.news": "NEWS",
        "menu.links": "LINKS",
        "menu.changelog": "CHANGELOG",

        "welcome.testMode": "⚠️ TEST MODE",
        "welcome.testnetBody":
            "THIS PROJECT IS CURRENTLY RUNNING ON THE TON TESTNET.",
        "welcome.testnetWalletsOnly":
            "USE TESTNET GRAM (TON) WALLETS ONLY.",
        "welcome.testnetDismiss": "Tap anywhere on this message to continue.",

        "page.welcome.title": "WELCOME TO WHEELWIN",
        "page.lobby.title": "CREATE OR JOIN ROOM",
        "page.setup.title": "PLAYER SETUP",
        "page.matrix.title": "SECRET MATRIX",
        "page.verify.title": "VERIFY",
        "page.payment.title": "PAYMENT",
        "page.result.title": "GAME FINISHED",

        "room.createRoom": "CREATE ROOM",
        "room.roomCreated": "ROOM CREATED ✓",
        "room.joinRoom": "JOIN ROOM",
        "room.roomId": "Room ID",
        "room.enterRoomId": "Enter Room ID",
        "room.waitingForPlayers": "Waiting for players...",
        "room.playersConnected": "Players connected",
        "room.connected": "Connected ✓",
        "room.unableToJoin": "Unable to join room.",
        "room.closed": "The room was closed.",

        "setup.yourLanguage": "YOUR LANGUAGE",
        "setup.nickname": "INPUT YOUR NICKNAME",
        "setup.age": "HOW OLD ARE YOU?",
        "setup.ageHint": "You must be between {min} and {max} years old.",
        "setup.baseStake": "BASE STAKE",
        "setup.sectors": "SECTORS",
        "setup.arrangement": "ARRANGEMENT",
        "setup.colorSector1": "COLOR FOR SECTOR 1",
        "setup.colorSector2": "COLOR FOR SECTOR 2",
        "setup.oneGram": "1 GRAM",
        "setup.tenGram": "10 GRAM",
        "setup.oneSector": "1 SECTOR",
        "setup.twoSectors": "2 SECTORS",
        "setup.together": "TOGETHER",
        "setup.separate": "SEPARATE",

        "matrix.title": "Secret Matrix",
        "matrix.instruction":
            "Each player enters a private secret code in the 3×3 matrix below. Use letters A–Z and digits 0–9. All three players must enter the same code.",
        "matrix.sideHint":
            "INPUT YOUR SECRET CODE.\n\nYOUR OTHER TWO FRIENDS\nMUST INPUT SAME.",
        "matrix.waitingCount": "Waiting for players… {submitted}/{required}",
        "matrix.waitingAll":
            "Waiting for all players to submit the same code…",
        "matrix.connectionRestored":
            "Connection restored. Press NEXT again to submit.",
        "matrix.mismatch": "Secret Matrix codes do not match. Try again.",
        "matrix.incomplete":
            "Enter a complete Secret Matrix using A–Z and 0–9 only.",
        "matrix.rejected": "Secret Matrix was rejected. Try again.",

        "verify.waitingForPlayers": "Waiting for players…",
        "verify.waitingConfirm": "Waiting for all players to confirm…",
        "verify.waitingContinue": "Waiting for all players to continue…",
        "verify.continuingToPayment":
            "Players verified. Continuing to payment…",
        "verify.enterWalletToContinue":
            "Players verified. Enter a valid wallet to continue.",
        "verify.baseStake": "BASE STAKE",
        "verify.youNeedPayGram": "YOU NEED PAY GRAM",
        "verify.walletLabel":
            "ENTER YOUR GRAM (TON) TELEGRAM WALLET ADDRESS",
        "verify.invalidWallet": "Invalid TON wallet address.",
        "verify.youNeedPay": "YOU NEED PAY",

        "player.you": "PLAYER {n} — YOU",
        "player.other": "PLAYER {n}",
        "player.yourNickname": "YOUR NICKNAME",
        "player.playerNickname": "PLAYER NICKNAME",

        "payment.connectWallet": "CONNECT TELEGRAM WALLET",
        "payment.disconnect": "DISCONNECT",
        "payment.confirmInWallet": "CONFIRM IN TELEGRAM WALLET",
        "payment.openingWallet": "OPENING WALLET…",
        "payment.allConfirmed": "All payments confirmed",
        "payment.deploymentFailed": "Deployment failed",
        "payment.sessionFailed": "Payment session failed",
        "payment.desktopConnection": "Desktop connection",
        "payment.universalLink": "Universal Link",
        "payment.openWallet": "Open Wallet",
        "payment.walletMismatch":
            "Connected wallet does not match the wallet entered during VERIFY.",
        "payment.telegramSessionNoAddress":
            "Telegram Wallet session is active but no account address "
            + "is available. Disconnect and connect again.",
        "payment.unableOpenTelegramWallet": "Unable to open Telegram Wallet.",
        "payment.telegramNotConnected": "Telegram Wallet is not connected.",
        "payment.unablePrepareTransaction":
            "Unable to prepare payment transaction.",
        "payment.walletRejected":
            "Wallet rejected or cancelled the payment request.",
        "payment.walletConnected": "Wallet Connected ✓",
        "payment.addressMismatch": "Address Mismatch",
        "payment.connecting": "Connecting…",
        "payment.walletPending": "Wallet Pending",
        "payment.walletRegistered": "Wallet Registered ✓",
        "payment.walletMissing": "Wallet Missing",
        "payment.paid": "Paid ✓",
        "payment.failed": "Failed",
        "payment.cancelled": "Cancelled",
        "payment.waitingConfirmation": "Waiting for Confirmation",
        "payment.waitingBlockchain": "Waiting for Blockchain...",
        "payment.waitingForPayments": "Waiting for payments",
        "payment.paymentRequested": "Payment Requested",
        "payment.paymentConfirmed": "Payment Confirmed",
        "payment.preparing": "Preparing payment...",
        "payment.statusWaiting": "WAITING",
        "payment.statusConnecting": "CONNECTING",
        "payment.statusConnected": "CONNECTED",
        "payment.statusAddressMismatch": "ADDRESS MISMATCH",
        "payment.creating": "Creating...",
        "payment.created": "Created ✓",
        "payment.smartContractFailed": "Smart Contract Failed",
        "player.age": "AGE",
        "player.sector": "SECTOR",

        "game.youMustWin": "YOU MUST WIN",
        "game.youWin": "YOU WIN",
        "game.youLost": "YOU LOST",
        "game.waitingResult": "Waiting for result…",

        "result.gameSummary": "Game summary",
        "result.winningSector": "Winning Sector",
        "result.winningColor": "Winning Color",
        "result.winnerPayout": "Winner Payout",
        "result.youReceived": "You received",
        "result.awaitingSettlement": "Awaiting settlement…",
        "result.settlementInProgress": "Settlement in progress…",
        "result.paymentCompleted": "Payment completed",
        "result.paymentFailed": "Payment failed",
        "result.auditPending": "Audit pending",
        "result.auditCompleted": "Audit completed",
        "result.auditUnavailable": "Audit unavailable",
        "result.gameReport": "Game Report",
        "result.downloadTxt": "Download TXT",
        "result.awaitingReport": "Awaiting authoritative report…",
        "result.waitingAuthoritative":
            "Waiting for the authoritative result…",
        "result.recoveryInformation": "Recovery Information",
        "result.playAgain": "Play Again",
        "result.roomReturn": "Room Return",
        "result.zeroGrm": "0.00 GRM",

        "infobar.roomId": "ROOM ID",
        "infobar.players": "PLAYERS",
        "infobar.timer": "TIMER",
        "infobar.gameTimer": "GAME TIMER",
        "infobar.setupTimer": "SETUP TIMER",
        "infobar.phase.PRE_GAME_READY": "PREPARATION",
        "infobar.phase.READY": "READY",
        "infobar.phase.SELF_TEST": "SELF TEST",
        "infobar.phase.SPEED": "SPINNING",
        "infobar.phase.BRAKE": "BRAKING",
        "infobar.phase.RESULT": "RESULT"
    })
});

export function translate(languageCode, key, vars = null) {

    const catalog = TRANSLATIONS[languageCode] ?? TRANSLATIONS.en;

    let text = catalog[key] ?? TRANSLATIONS.en[key] ?? key;

    if (vars && typeof text === "string") {

        for (const [name, value] of Object.entries(vars)) {

            text = text.replaceAll(`{${name}}`, String(value));

        }

    }

    return text;

}
