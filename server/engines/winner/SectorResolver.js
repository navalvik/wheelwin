export class SectorResolver {

    constructor({ geometryAdapter }) {

        this._geometryAdapter = geometryAdapter;

    }

    resolve({
        configuration,
        finalWheelAngleRadians,
        triangleAngleDegrees
    }) {

        const sectors = configuration.sectors;

        const sectorIndex = this._geometryAdapter.resolveSectorIndex({
            finalWheelAngleRadians,
            triangleAngleDegrees,
            sectorCount: sectors.length
        });

        const sector = sectors[sectorIndex];

        if (!sector) {

            throw new Error("Winning sector could not be resolved");

        }

        return {
            index: sectorIndex,
            sectorId: sector.sectorId,
            ownerId: sector.ownerId,
            color: sector.color,
            icon: sector.icon
        };

    }

}
