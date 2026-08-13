/**
 * R6.6 / R17.1 / R17.3 — UI string catalogs keyed by language code.
 * English is the complete source of truth for player-facing UI.
 * Spanish (es) must keep the same key set as English.
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
    }),

    es: Object.freeze({
        "common.next": "SIGUIENTE",
        "common.back": "ATRÁS",
        "common.finish": "FINALIZAR",
        "common.loadingDocument": "Cargando documento...",
        "common.documentNotFound": "Documento no encontrado.",
        "common.language": "Idioma",
        "common.waiting": "Esperando",
        "common.icon": "ICONO",
        "common.status": "Estado",
        "common.wallet": "Wallet",
        "common.copy": "Copiar",
        "common.copied": "Copiado",

        "menu.welcome": "INICIO",
        "menu.rules": "REGLAS",
        "menu.faq": "FAQ",
        "menu.privacy": "PRIVACIDAD",
        "menu.terms": "TÉRMINOS",
        "menu.news": "NOTICIAS",
        "menu.links": "ENLACES",
        "menu.changelog": "CAMBIOS",

        "welcome.testMode": "⚠️ MODO DE PRUEBA",
        "welcome.testnetBody":
            "ESTE PROYECTO ESTÁ FUNCIONANDO ACTUALMENTE EN LA TON TESTNET.",
        "welcome.testnetWalletsOnly":
            "USA SOLO WALLETS DE GRAM (TON) DE TESTNET.",
        "welcome.testnetDismiss": "Toca este mensaje en cualquier lugar para continuar.",

        "page.welcome.title": "BIENVENIDO A WHEELWIN",
        "page.lobby.title": "CREAR O UNIRSE A UNA SALA",
        "page.setup.title": "CONFIGURACIÓN DEL JUGADOR",
        "page.matrix.title": "MATRIZ SECRETA",
        "page.verify.title": "VERIFICAR",
        "page.payment.title": "PAGO",
        "page.result.title": "JUEGO TERMINADO",

        "room.createRoom": "CREAR SALA",
        "room.roomCreated": "SALA CREADA ✓",
        "room.joinRoom": "UNIRSE A LA SALA",
        "room.roomId": "ID de sala",
        "room.enterRoomId": "Ingresa el ID de sala",
        "room.waitingForPlayers": "Esperando jugadores...",
        "room.playersConnected": "Jugadores conectados",
        "room.connected": "Conectado ✓",
        "room.unableToJoin": "No se pudo unir a la sala.",
        "room.closed": "La sala fue cerrada.",

        "setup.yourLanguage": "TU IDIOMA",
        "setup.nickname": "INGRESA TU APODO",
        "setup.age": "¿CUÁNTOS AÑOS TIENES?",
        "setup.ageHint": "Debes tener entre {min} y {max} años.",
        "setup.baseStake": "APUESTA BASE",
        "setup.sectors": "SECTORES",
        "setup.arrangement": "DISPOSICIÓN",
        "setup.colorSector1": "COLOR DEL SECTOR 1",
        "setup.colorSector2": "COLOR DEL SECTOR 2",
        "setup.oneGram": "1 GRAM",
        "setup.tenGram": "10 GRAM",
        "setup.oneSector": "1 SECTOR",
        "setup.twoSectors": "2 SECTORES",
        "setup.together": "JUNTOS",
        "setup.separate": "SEPARADOS",

        "matrix.title": "Matriz secreta",
        "matrix.instruction":
            "Cada jugador ingresa un código secreto privado en la matriz 3×3 de abajo. Usa letras A–Z y dígitos 0–9. Los tres jugadores deben ingresar el mismo código.",
        "matrix.sideHint":
            "INGRESA TU CÓDIGO SECRETO.\n\nTUS OTROS DOS AMIGOS\nDEBEN INGRESAR EL MISMO.",
        "matrix.waitingCount": "Esperando jugadores… {submitted}/{required}",
        "matrix.waitingAll":
            "Esperando que todos los jugadores envíen el mismo código…",
        "matrix.connectionRestored":
            "Conexión restaurada. Presiona SIGUIENTE de nuevo para enviar.",
        "matrix.mismatch": "Los códigos de la Matriz secreta no coinciden. Inténtalo de nuevo.",
        "matrix.incomplete":
            "Ingresa una Matriz secreta completa usando solo A–Z y 0–9.",
        "matrix.rejected": "La Matriz secreta fue rechazada. Inténtalo de nuevo.",

        "verify.waitingForPlayers": "Esperando jugadores…",
        "verify.waitingConfirm": "Esperando que todos los jugadores confirmen…",
        "verify.waitingContinue": "Esperando que todos los jugadores continúen…",
        "verify.continuingToPayment":
            "Jugadores verificados. Continuando al pago…",
        "verify.enterWalletToContinue":
            "Jugadores verificados. Ingresa una wallet válida para continuar.",
        "verify.baseStake": "APUESTA BASE",
        "verify.youNeedPayGram": "DEBES PAGAR GRAM",
        "verify.walletLabel":
            "INGRESA LA DIRECCIÓN DE TU WALLET DE GRAM (TON) TELEGRAM",
        "verify.invalidWallet": "Dirección de wallet TON no válida.",
        "verify.youNeedPay": "DEBES PAGAR",

        "player.you": "JUGADOR {n} — TÚ",
        "player.other": "JUGADOR {n}",
        "player.yourNickname": "TU APODO",
        "player.playerNickname": "APODO DEL JUGADOR",

        "payment.connectWallet": "CONECTAR TELEGRAM WALLET",
        "payment.disconnect": "DESCONECTAR",
        "payment.confirmInWallet": "CONFIRMAR EN TELEGRAM WALLET",
        "payment.openingWallet": "ABRIENDO WALLET…",
        "payment.allConfirmed": "Todos los pagos confirmados",
        "payment.deploymentFailed": "Error en el despliegue",
        "payment.sessionFailed": "Error en la sesión de pago",
        "payment.desktopConnection": "Conexión de escritorio",
        "payment.universalLink": "Universal Link",
        "payment.openWallet": "Abrir Wallet",
        "payment.walletMismatch":
            "La wallet conectada no coincide con la wallet ingresada en VERIFY.",
        "payment.telegramSessionNoAddress":
            "La sesión de Telegram Wallet está activa, pero no hay "
            + "dirección de cuenta disponible. Desconecta y vuelve a conectar.",
        "payment.unableOpenTelegramWallet": "No se pudo abrir Telegram Wallet.",
        "payment.telegramNotConnected": "Telegram Wallet no está conectada.",
        "payment.unablePrepareTransaction":
            "No se pudo preparar la transacción de pago.",
        "payment.walletRejected":
            "La wallet rechazó o canceló la solicitud de pago.",
        "payment.walletConnected": "Wallet conectada ✓",
        "payment.addressMismatch": "Dirección no coincide",
        "payment.connecting": "Conectando…",
        "payment.walletPending": "Wallet pendiente",
        "payment.walletRegistered": "Wallet registrada ✓",
        "payment.walletMissing": "Wallet faltante",
        "payment.paid": "Pagado ✓",
        "payment.failed": "Fallido",
        "payment.cancelled": "Cancelado",
        "payment.waitingConfirmation": "Esperando confirmación",
        "payment.waitingBlockchain": "Esperando la blockchain...",
        "payment.waitingForPayments": "Esperando pagos",
        "payment.paymentRequested": "Pago solicitado",
        "payment.paymentConfirmed": "Pago confirmado",
        "payment.preparing": "Preparando el pago...",
        "payment.statusWaiting": "ESPERANDO",
        "payment.statusConnecting": "CONECTANDO",
        "payment.statusConnected": "CONECTADO",
        "payment.statusAddressMismatch": "DIRECCIÓN NO COINCIDE",
        "payment.creating": "Creando...",
        "payment.created": "Creado ✓",
        "payment.smartContractFailed": "Error del smart contract",
        "player.age": "EDAD",
        "player.sector": "SECTOR",

        "game.youMustWin": "DEBES GANAR",
        "game.youWin": "GANASTE",
        "game.youLost": "PERDISTE",
        "game.waitingResult": "Esperando el resultado…",

        "result.gameSummary": "Resumen de la partida",
        "result.winningSector": "Sector ganador",
        "result.winningColor": "Color ganador",
        "result.winnerPayout": "Pago al ganador",
        "result.youReceived": "Recibiste",
        "result.awaitingSettlement": "Esperando liquidación…",
        "result.settlementInProgress": "Liquidación en curso…",
        "result.paymentCompleted": "Pago completado",
        "result.paymentFailed": "Pago fallido",
        "result.auditPending": "Auditoría pendiente",
        "result.auditCompleted": "Auditoría completada",
        "result.auditUnavailable": "Auditoría no disponible",
        "result.gameReport": "Informe de la partida",
        "result.downloadTxt": "Descargar TXT",
        "result.awaitingReport": "Esperando el informe oficial…",
        "result.waitingAuthoritative":
            "Esperando el resultado oficial…",
        "result.recoveryInformation": "Información de recuperación",
        "result.playAgain": "Jugar de nuevo",
        "result.roomReturn": "Volver a la sala",
        "result.zeroGrm": "0.00 GRM",

        "infobar.roomId": "ID DE SALA",
        "infobar.players": "JUGADORES",
        "infobar.timer": "TEMPORIZADOR",
        "infobar.gameTimer": "TEMPORIZADOR DE JUEGO",
        "infobar.setupTimer": "TEMPORIZADOR DE CONFIGURACIÓN",
        "infobar.phase.PRE_GAME_READY": "PREPARACIÓN",
        "infobar.phase.READY": "LISTO",
        "infobar.phase.SELF_TEST": "AUTOTEST",
        "infobar.phase.SPEED": "GIRANDO",
        "infobar.phase.BRAKE": "FRENANDO",
        "infobar.phase.RESULT": "RESULTADO"
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
