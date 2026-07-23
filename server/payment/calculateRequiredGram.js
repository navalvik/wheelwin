/**
 * P6.3 — Authoritative GRM amount for entry payment.
 * first sector = 1 × baseStake; second sector = 1.5 × baseStake.
 */
export function calculateRequiredGram(baseStake, sectorCount = 1) {

    const stake = Number(baseStake);

    if (!Number.isFinite(stake) || stake <= 0) {

        return null;

    }

    const firstSectorCost = stake;

    if (Number(sectorCount) !== 2) {

        return Math.round(firstSectorCost * 100) / 100;

    }

    const secondSectorCost = stake * 1.5;

    return Math.round((firstSectorCost + secondSectorCost) * 100) / 100;

}
