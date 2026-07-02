export class PlayerResolver {

    resolve({ configuration, winningSector }) {

        const ownerId = winningSector.ownerId;

        if (!ownerId) {

            throw new Error("Winning sector has no owner");

        }

        const player = configuration.players.find(
            (entry) => entry.playerId === ownerId
        );

        if (!player) {

            throw new Error(`Winning player owner not found (${ownerId})`);

        }

        return {
            playerId: player.playerId,
            color: player.color,
            icon: player.icon
        };

    }

}
