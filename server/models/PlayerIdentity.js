export class PlayerIdentity {

    constructor({
        playerId = null,
        nickname = null,
        wallet = null,
        icon = null,
        age = null,
        color = null,
        sectorCount = null,
        sectorArrangement = null,
        createdAt = null
    } = {}) {

        this.playerId = playerId;

        this.nickname = nickname;

        this.wallet = wallet;

        this.icon = icon;

        this.age = age;

        this.color = color;

        this.sectorCount = sectorCount;

        this.sectorArrangement = sectorArrangement;

        this.createdAt = createdAt;

        Object.freeze(this);

    }

    toSnapshot() {

        return {
            playerId: this.playerId,
            nickname: this.nickname,
            wallet: this.wallet,
            icon: this.icon,
            age: this.age,
            color: this.color,
            sectorCount: this.sectorCount,
            sectorArrangement: this.sectorArrangement,
            createdAt: this.createdAt
        };

    }

}
