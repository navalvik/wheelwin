export class PlayerIdentity {

    constructor({
        playerId = null,
        nickname = null,
        wallet = null,
        icon = null,
        createdAt = null
    } = {}) {

        this.playerId = playerId;

        this.nickname = nickname;

        this.wallet = wallet;

        this.icon = icon;

        this.createdAt = createdAt;

        Object.freeze(this);

    }

    toSnapshot() {

        return {
            playerId: this.playerId,
            nickname: this.nickname,
            wallet: this.wallet,
            icon: this.icon,
            createdAt: this.createdAt
        };

    }

}
