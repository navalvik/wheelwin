/**
 * R6.6 / R17.1 / R17.3–R17.6 — UI string catalogs keyed by language code.
 * English is the complete source of truth for player-facing UI.
 * es / pt / fr / zh must keep the same key set as English.
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
        "common.copied": "Copied",
        "common.bannerAlt": "WheelWin Banner",

        "menu.welcome": "WELCOME",
        "menu.rules": "RULES",
        "menu.faq": "FAQ",
        "menu.privacy": "PRIVACY",
        "menu.terms": "TERMS",
        "menu.news": "NEWS",
        "menu.links": "LINKS",
        "menu.changelog": "CHANGELOG",

        "welcome.testMode": "⚠️ TEST MODE",
        "welcome.mainnetMode": "⚠️ MAINNET",

        "welcome.testnetBody":
            "This project runs on TON Testnet, a test network. It is NOT the production Mainnet, and no real funds are involved.",
        "welcome.mainnetBody":
            "This project runs on TON Mainnet, the production network. Actions here may have real financial consequences.",
        "welcome.testnetDismiss": "Tap anywhere on this message to continue.",
        "welcome.mainnetDismiss": "Tap anywhere on this message to continue.",

        "page.welcome.title": "WELCOME TO WHEELWIN",
        "page.lobby.title": "CREATE OR JOIN ROOM",
        "page.setup.title": "PLAYER SETUP",
        "page.matrix.title": "SECRET MATRIX",
        "page.verify.title": "VERIFY",
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
        // R20 — Owner-only one-time room network selection. English-only keys;
        // translate() falls back to this catalog for every other language.
        "room.networkLabel": "Network",
        "room.networkPrompt": "Select room network",
        "room.networkTestnet": "Testnet",
        "room.networkMainnet": "Mainnet",

        "setup.yourLanguage": "YOUR LANGUAGE",
        "setup.nickname": "INPUT YOUR NICKNAME",
        "setup.age": "HOW OLD ARE YOU?",
        "setup.ageHint": "You must be between {min} and {max} years old.",
        "setup.sectors": "SECTORS",
        "setup.arrangement": "ARRANGEMENT",
        "setup.colorSector1": "COLOR FOR SECTOR 1",
        "setup.colorSector2": "COLOR FOR SECTOR 2",
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

        "player.you": "PLAYER {n} — YOU",
        "player.other": "PLAYER {n}",
        "player.yourNickname": "YOUR NICKNAME",
        "player.playerNickname": "PLAYER NICKNAME",

        "player.sector": "SECTOR",

        "game.youMustWin": "YOU MUST WIN",
        "game.youWin": "YOU WIN",
        "game.youLost": "YOU LOST",
        "game.waitingResult": "Waiting for result…",
        "game.buttonPush": "PUSH",
        "game.buttonReady": "READY",
        "game.buttonCountdown": "COUNTDOWN",
        "game.buttonSpin": "SPIN",
        "game.buttonWin": "WIN",
        "game.buttonLost": "LOST",
        "game.playerReady": "✓ READY",
        "game.playerWaiting": "WAITING",
        "game.sectorSingular": "{count} sector",
        "game.sectorPlural": "{count} sectors",

        "result.gameSummary": "Game summary",
        "result.winningSector": "Winning Sector",
        "result.winningColor": "Winning Color",
        "result.gameReport": "Game Report",
        "result.downloadTxt": "Download TXT",
        "result.awaitingReport": "Awaiting authoritative report…",
        "result.waitingAuthoritative":
            "Waiting for the authoritative result…",
        "result.recoveryInformation": "Recovery Information",
        "result.playAgain": "Play Again",
        "result.roomReturn": "Room Return",

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
        "common.copied": "Copiado",
        "common.bannerAlt": "Banner de WheelWin",

        "menu.welcome": "INICIO",
        "menu.rules": "REGLAS",
        "menu.faq": "FAQ",
        "menu.privacy": "PRIVACIDAD",
        "menu.terms": "TÉRMINOS",
        "menu.news": "NOTICIAS",
        "menu.links": "ENLACES",
        "menu.changelog": "CAMBIOS",

        "welcome.testMode": "⚠️ MODO DE PRUEBA",
        "welcome.testnetDismiss": "Toca este mensaje en cualquier lugar para continuar.",

        "page.welcome.title": "BIENVENIDO A WHEELWIN",
        "page.lobby.title": "CREAR O UNIRSE A UNA SALA",
        "page.setup.title": "CONFIGURACIÓN DEL JUGADOR",
        "page.matrix.title": "MATRIZ SECRETA",
        "page.verify.title": "VERIFICAR",
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
        "setup.sectors": "SECTORES",
        "setup.arrangement": "DISPOSICIÓN",
        "setup.colorSector1": "COLOR DEL SECTOR 1",
        "setup.colorSector2": "COLOR DEL SECTOR 2",
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

        "player.you": "JUGADOR {n} — TÚ",
        "player.other": "JUGADOR {n}",
        "player.yourNickname": "TU APODO",
        "player.playerNickname": "APODO DEL JUGADOR",

        "player.sector": "SECTOR",

        "game.youMustWin": "DEBES GANAR",
        "game.youWin": "GANASTE",
        "game.youLost": "PERDISTE",
        "game.waitingResult": "Esperando el resultado…",
        "game.buttonPush": "PULSA",
        "game.buttonReady": "LISTO",
        "game.buttonCountdown": "CUENTA ATRÁS",
        "game.buttonSpin": "GIRA",
        "game.buttonWin": "GANA",
        "game.buttonLost": "PIERDE",
        "game.playerReady": "✓ LISTO",
        "game.playerWaiting": "ESPERANDO",
        "game.sectorSingular": "{count} sector",
        "game.sectorPlural": "{count} sectores",

        "result.gameSummary": "Resumen de la partida",
        "result.winningSector": "Sector ganador",
        "result.winningColor": "Color ganador",
        "result.gameReport": "Informe de la partida",
        "result.downloadTxt": "Descargar TXT",
        "result.awaitingReport": "Esperando el informe oficial…",
        "result.waitingAuthoritative":
            "Esperando el resultado oficial…",
        "result.recoveryInformation": "Información de recuperación",
        "result.playAgain": "Jugar de nuevo",
        "result.roomReturn": "Volver a la sala",

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
    }),

    pt: Object.freeze({
        "common.next": "PRÓXIMO",
        "common.back": "VOLTAR",
        "common.finish": "FINALIZAR",
        "common.loadingDocument": "Carregando documento...",
        "common.documentNotFound": "Documento não encontrado.",
        "common.language": "Idioma",
        "common.waiting": "Aguardando",
        "common.icon": "ÍCONE",
        "common.status": "Status",
        "common.copied": "Copiado",
        "common.bannerAlt": "Banner do WheelWin",

        "menu.welcome": "INÍCIO",
        "menu.rules": "REGRAS",
        "menu.faq": "FAQ",
        "menu.privacy": "PRIVACIDADE",
        "menu.terms": "TERMOS",
        "menu.news": "NOTÍCIAS",
        "menu.links": "LINKS",
        "menu.changelog": "MUDANÇAS",

        "welcome.testMode": "⚠️ MODO DE TESTE",
        "welcome.testnetDismiss": "Toque em qualquer lugar nesta mensagem para continuar.",

        "page.welcome.title": "BEM-VINDO AO WHEELWIN",
        "page.lobby.title": "CRIAR OU ENTRAR EM UMA SALA",
        "page.setup.title": "CONFIGURAÇÃO DO JOGADOR",
        "page.matrix.title": "MATRIZ SECRETA",
        "page.verify.title": "VERIFICAR",
        "page.result.title": "JOGO FINALIZADO",

        "room.createRoom": "CRIAR SALA",
        "room.roomCreated": "SALA CRIADA ✓",
        "room.joinRoom": "ENTRAR NA SALA",
        "room.roomId": "ID da sala",
        "room.enterRoomId": "Digite o ID da sala",
        "room.waitingForPlayers": "Aguardando jogadores...",
        "room.playersConnected": "Jogadores conectados",
        "room.connected": "Conectado ✓",
        "room.unableToJoin": "Não foi possível entrar na sala.",
        "room.closed": "A sala foi fechada.",

        "setup.yourLanguage": "SEU IDIOMA",
        "setup.nickname": "DIGITE SEU APELIDO",
        "setup.age": "QUANTOS ANOS VOCÊ TEM?",
        "setup.ageHint": "Você deve ter entre {min} e {max} anos.",
        "setup.sectors": "SETORES",
        "setup.arrangement": "DISPOSIÇÃO",
        "setup.colorSector1": "COR DO SETOR 1",
        "setup.colorSector2": "COR DO SETOR 2",
        "setup.oneSector": "1 SETOR",
        "setup.twoSectors": "2 SETORES",
        "setup.together": "JUNTOS",
        "setup.separate": "SEPARADOS",

        "matrix.title": "Matriz secreta",
        "matrix.instruction":
            "Cada jogador digita um código secreto privado na matriz 3×3 abaixo. Use letras A–Z e dígitos 0–9. Os três jogadores devem digitar o mesmo código.",
        "matrix.sideHint":
            "DIGITE SEU CÓDIGO SECRETO.\n\nSEUS OUTROS DOIS AMIGOS\nDEVEM DIGITAR O MESMO.",
        "matrix.waitingCount": "Aguardando jogadores… {submitted}/{required}",
        "matrix.waitingAll":
            "Aguardando todos os jogadores enviarem o mesmo código…",
        "matrix.connectionRestored":
            "Conexão restaurada. Pressione PRÓXIMO novamente para enviar.",
        "matrix.mismatch": "Os códigos da Matriz secreta não coincidem. Tente novamente.",
        "matrix.incomplete":
            "Digite uma Matriz secreta completa usando apenas A–Z e 0–9.",
        "matrix.rejected": "A Matriz secreta foi rejeitada. Tente novamente.",

        "verify.waitingForPlayers": "Aguardando jogadores…",
        "verify.waitingConfirm": "Aguardando todos os jogadores confirmarem…",
        "verify.waitingContinue": "Aguardando todos os jogadores continuarem…",

        "player.you": "JOGADOR {n} — VOCÊ",
        "player.other": "JOGADOR {n}",
        "player.yourNickname": "SEU APELIDO",
        "player.playerNickname": "APELIDO DO JOGADOR",

        "player.sector": "SETOR",

        "game.youMustWin": "VOCÊ PRECISA GANHAR",
        "game.youWin": "VOCÊ GANHOU",
        "game.youLost": "VOCÊ PERDEU",
        "game.waitingResult": "Aguardando o resultado…",
        "game.buttonPush": "APERTE",
        "game.buttonReady": "PRONTO",
        "game.buttonCountdown": "CONTAGEM",
        "game.buttonSpin": "GIRAR",
        "game.buttonWin": "VENCEU",
        "game.buttonLost": "PERDEU",
        "game.playerReady": "✓ PRONTO",
        "game.playerWaiting": "AGUARDANDO",
        "game.sectorSingular": "{count} setor",
        "game.sectorPlural": "{count} setores",

        "result.gameSummary": "Resumo da partida",
        "result.winningSector": "Setor vencedor",
        "result.winningColor": "Cor vencedora",
        "result.gameReport": "Relatório da partida",
        "result.downloadTxt": "Baixar TXT",
        "result.awaitingReport": "Aguardando o relatório oficial…",
        "result.waitingAuthoritative":
            "Aguardando o resultado oficial…",
        "result.recoveryInformation": "Informações de recuperação",
        "result.playAgain": "Jogar novamente",
        "result.roomReturn": "Voltar à sala",

        "infobar.roomId": "ID DA SALA",
        "infobar.players": "JOGADORES",
        "infobar.timer": "TEMPORIZADOR",
        "infobar.gameTimer": "TEMPORIZADOR DO JOGO",
        "infobar.setupTimer": "TEMPORIZADOR DE CONFIGURAÇÃO",
        "infobar.phase.PRE_GAME_READY": "PREPARAÇÃO",
        "infobar.phase.READY": "PRONTO",
        "infobar.phase.SELF_TEST": "AUTOTESTE",
        "infobar.phase.SPEED": "GIRANDO",
        "infobar.phase.BRAKE": "FREANDO",
        "infobar.phase.RESULT": "RESULTADO"
    }),

    fr: Object.freeze({
        "common.next": "SUIVANT",
        "common.back": "RETOUR",
        "common.finish": "TERMINER",
        "common.loadingDocument": "Chargement du document...",
        "common.documentNotFound": "Document introuvable.",
        "common.language": "Langue",
        "common.waiting": "En attente",
        "common.icon": "ICÔNE",
        "common.status": "Statut",
        "common.copied": "Copié",
        "common.bannerAlt": "Bannière WheelWin",

        "menu.welcome": "ACCUEIL",
        "menu.rules": "RÈGLES",
        "menu.faq": "FAQ",
        "menu.privacy": "CONFIDENTIALITÉ",
        "menu.terms": "CONDITIONS",
        "menu.news": "ACTUALITÉS",
        "menu.links": "LIENS",
        "menu.changelog": "JOURNAL",

        "welcome.testMode": "⚠️ MODE TEST",

        "welcome.mainnetMode": "⚠️ MAINNET",

        "welcome.testnetDismiss": "Touchez n’importe où sur ce message pour continuer.",

        "welcome.testnetBody":
            "Ce projet s'exécute sur TON Testnet, un réseau de test. Ce n'est pas la Mainnet de production et aucun fond réel n'est impliqué.",
        "welcome.mainnetBody":
            "Ce projet s'exécute sur TON Mainnet, le réseau de production. Les actions ici peuvent avoir des conséquences financières réelles.",

        "page.welcome.title": "BIENVENUE SUR WHEELWIN",
        "page.lobby.title": "CRÉER OU REJOINDRE UNE SALLE",
        "page.setup.title": "CONFIGURATION DU JOUEUR",
        "page.matrix.title": "MATRICE SECRÈTE",
        "page.verify.title": "VÉRIFIER",
        "page.result.title": "PARTIE TERMINÉE",

        "room.createRoom": "CRÉER UNE SALLE",
        "room.roomCreated": "SALLE CRÉÉE ✓",
        "room.joinRoom": "REJOINDRE LA SALLE",
        "room.roomId": "ID de salle",
        "room.enterRoomId": "Saisir l’ID de salle",
        "room.waitingForPlayers": "En attente des joueurs...",
        "room.playersConnected": "Joueurs connectés",
        "room.connected": "Connecté ✓",
        "room.unableToJoin": "Impossible de rejoindre la salle.",
        "room.closed": "La salle a été fermée.",

        "setup.yourLanguage": "VOTRE LANGUE",
        "setup.nickname": "SAISISSEZ VOTRE PSEUDO",
        "setup.age": "QUEL ÂGE AVEZ-VOUS ?",
        "setup.ageHint": "Vous devez avoir entre {min} et {max} ans.",
        "setup.sectors": "SECTEURS",
        "setup.arrangement": "DISPOSITION",
        "setup.colorSector1": "COULEUR DU SECTEUR 1",
        "setup.colorSector2": "COULEUR DU SECTEUR 2",
        "setup.oneSector": "1 SECTEUR",
        "setup.twoSectors": "2 SECTEURS",
        "setup.together": "ENSEMBLE",
        "setup.separate": "SÉPARÉS",

        "matrix.title": "Matrice secrète",
        "matrix.instruction":
            "Chaque joueur saisit un code secret privé dans la matrice 3×3 ci-dessous. Utilisez les lettres A–Z et les chiffres 0–9. Les trois joueurs doivent saisir le même code.",
        "matrix.sideHint":
            "SAISISSEZ VOTRE CODE SECRET.\n\nVOS DEUX AUTRES AMIS\nDOIVENT SAISIR LE MÊME.",
        "matrix.waitingCount": "En attente des joueurs… {submitted}/{required}",
        "matrix.waitingAll":
            "En attente que tous les joueurs envoient le même code…",
        "matrix.connectionRestored":
            "Connexion rétablie. Appuyez à nouveau sur SUIVANT pour envoyer.",
        "matrix.mismatch": "Les codes de la Matrice secrète ne correspondent pas. Réessayez.",
        "matrix.incomplete":
            "Saisissez une Matrice secrète complète en utilisant uniquement A–Z et 0–9.",
        "matrix.rejected": "La Matrice secrète a été rejetée. Réessayez.",

        "verify.waitingForPlayers": "En attente des joueurs…",
        "verify.waitingConfirm": "En attente de la confirmation de tous les joueurs…",
        "verify.waitingContinue": "En attente que tous les joueurs continuent…",

        "player.you": "JOUEUR {n} — VOUS",
        "player.other": "JOUEUR {n}",
        "player.yourNickname": "VOTRE PSEUDO",
        "player.playerNickname": "PSEUDO DU JOUEUR",

        "player.sector": "SECTEUR",

        "game.youMustWin": "VOUS DEVEZ GAGNER",
        "game.youWin": "VOUS GAGNEZ",
        "game.youLost": "VOUS PERDEZ",
        "game.waitingResult": "En attente du résultat…",
        "game.buttonPush": "APPUYEZ",
        "game.buttonReady": "PRÊT",
        "game.buttonCountdown": "COMPTE À REBOURS",
        "game.buttonSpin": "TOURNEZ",
        "game.buttonWin": "GAGNÉ",
        "game.buttonLost": "PERDU",
        "game.playerReady": "✓ PRÊT",
        "game.playerWaiting": "EN ATTENTE",
        "game.sectorSingular": "{count} secteur",
        "game.sectorPlural": "{count} secteurs",

        "result.gameSummary": "Résumé de la partie",
        "result.winningSector": "Secteur gagnant",
        "result.winningColor": "Couleur gagnante",
        "result.gameReport": "Rapport de partie",
        "result.downloadTxt": "Télécharger TXT",
        "result.awaitingReport": "En attente du rapport officiel…",
        "result.waitingAuthoritative":
            "En attente du résultat officiel…",
        "result.recoveryInformation": "Informations de récupération",
        "result.playAgain": "Rejouer",
        "result.roomReturn": "Retour à la salle",

        "infobar.roomId": "ID DE SALLE",
        "infobar.players": "JOUEURS",
        "infobar.timer": "MINUTEUR",
        "infobar.gameTimer": "MINUTEUR DE JEU",
        "infobar.setupTimer": "MINUTEUR DE CONFIGURATION",
        "infobar.phase.PRE_GAME_READY": "PRÉPARATION",
        "infobar.phase.READY": "PRÊT",
        "infobar.phase.SELF_TEST": "AUTOTEST",
        "infobar.phase.SPEED": "ROTATION",
        "infobar.phase.BRAKE": "FREINAGE",
        "infobar.phase.RESULT": "RÉSULTAT"
    }),

    zh: Object.freeze({
        "common.next": "下一步",
        "common.back": "返回",
        "common.finish": "完成",
        "common.loadingDocument": "正在加载文档...",
        "common.documentNotFound": "未找到文档。",
        "common.language": "语言",
        "common.waiting": "等待中",
        "common.icon": "图标",
        "common.status": "状态",
        "common.copied": "已复制",
        "common.bannerAlt": "WheelWin 横幅",

        "menu.welcome": "首页",
        "menu.rules": "规则",
        "menu.faq": "FAQ",
        "menu.privacy": "隐私",
        "menu.terms": "条款",
        "menu.news": "新闻",
        "menu.links": "链接",
        "menu.changelog": "更新日志",

        "welcome.testMode": "⚠️ 测试模式",
        "welcome.mainnetMode": "⚠️ 主网",
        "welcome.testnetBody":
            "本项目运行于 TON 测试网，这是一个测试网络。它不是生产主网，不涉及真实资金。",
        "welcome.mainnetBody":
            "本项目运行于 TON 主网，即生产网络。此处的操作可能产生真实的财务后果。",
        "welcome.testnetDismiss": "点击此消息任意位置以继续。",
        "welcome.mainnetDismiss": "点击此消息任意位置以继续。",

        "page.welcome.title": "欢迎来到 WHEELWIN",
        "page.lobby.title": "创建或加入房间",
        "page.setup.title": "玩家设置",
        "page.matrix.title": "秘密矩阵",
        "page.verify.title": "验证",
        "page.result.title": "游戏结束",

        "room.createRoom": "创建房间",
        "room.roomCreated": "房间已创建 ✓",
        "room.joinRoom": "加入房间",
        "room.roomId": "房间 ID",
        "room.enterRoomId": "输入房间 ID",
        "room.waitingForPlayers": "正在等待玩家...",
        "room.playersConnected": "已连接玩家",
        "room.connected": "已连接 ✓",
        "room.unableToJoin": "无法加入房间。",
        "room.closed": "房间已关闭。",

        "setup.yourLanguage": "你的语言",
        "setup.nickname": "输入你的昵称",
        "setup.age": "你多大了？",
        "setup.ageHint": "你的年龄必须在 {min} 到 {max} 岁之间。",
        "setup.sectors": "扇区",
        "setup.arrangement": "布局",
        "setup.colorSector1": "扇区 1 颜色",
        "setup.colorSector2": "扇区 2 颜色",
        "setup.oneSector": "1 扇区",
        "setup.twoSectors": "2 扇区",
        "setup.together": "相邻",
        "setup.separate": "分开",

        "matrix.title": "秘密矩阵",
        "matrix.instruction":
            "每位玩家在下方的 3×3 矩阵中输入私人密码。请使用字母 A–Z 和数字 0–9。三位玩家必须输入相同的密码。",
        "matrix.sideHint":
            "输入你的密码。\n\n另外两位好友\n必须输入相同内容。",
        "matrix.waitingCount": "正在等待玩家… {submitted}/{required}",
        "matrix.waitingAll":
            "正在等待所有玩家提交相同的密码…",
        "matrix.connectionRestored":
            "连接已恢复。请再次按下“下一步”以提交。",
        "matrix.mismatch": "秘密矩阵密码不一致。请重试。",
        "matrix.incomplete":
            "请填写完整的秘密矩阵，且仅使用 A–Z 和 0–9。",
        "matrix.rejected": "秘密矩阵已被拒绝。请重试。",

        "verify.waitingForPlayers": "正在等待玩家…",
        "verify.waitingConfirm": "正在等待所有玩家确认…",
        "verify.waitingContinue": "正在等待所有玩家继续…",

        "player.you": "玩家 {n} — 你",
        "player.other": "玩家 {n}",
        "player.yourNickname": "你的昵称",
        "player.playerNickname": "玩家昵称",

        "player.sector": "扇区",

        "game.youMustWin": "你必须获胜",
        "game.youWin": "你赢了",
        "game.youLost": "你输了",
        "game.waitingResult": "正在等待结果…",
        "game.buttonPush": "按下",
        "game.buttonReady": "就绪",
        "game.buttonCountdown": "倒计时",
        "game.buttonSpin": "旋转",
        "game.buttonWin": "胜",
        "game.buttonLost": "负",
        "game.playerReady": "✓ 就绪",
        "game.playerWaiting": "等待中",
        "game.sectorSingular": "{count} 个扇区",
        "game.sectorPlural": "{count} 个扇区",

        "result.gameSummary": "游戏摘要",
        "result.winningSector": "获胜扇区",
        "result.winningColor": "获胜颜色",
        "result.gameReport": "游戏报告",
        "result.downloadTxt": "下载 TXT",
        "result.awaitingReport": "等待官方报告…",
        "result.waitingAuthoritative":
            "等待官方结果…",
        "result.recoveryInformation": "恢复信息",
        "result.playAgain": "再玩一次",
        "result.roomReturn": "返回房间",

        "infobar.roomId": "房间 ID",
        "infobar.players": "玩家",
        "infobar.timer": "计时器",
        "infobar.gameTimer": "游戏计时器",
        "infobar.setupTimer": "设置计时器",
        "infobar.phase.PRE_GAME_READY": "准备中",
        "infobar.phase.READY": "就绪",
        "infobar.phase.SELF_TEST": "自检",
        "infobar.phase.SPEED": "旋转中",
        "infobar.phase.BRAKE": "制动中",
        "infobar.phase.RESULT": "结果"
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
