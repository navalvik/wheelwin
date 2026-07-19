export const SECRET_MATRIX_SIZE = 9;

export const SECRET_MATRIX_CELL_PATTERN = /^[A-Z0-9]$/;

/**
 * Authoritative Secret Matrix format gate.
 * Exactly 9 cells; each cell one A–Z / 0–9 character.
 */
export function normalizeSecretMatrix(rawMatrix) {

    if (!Array.isArray(rawMatrix) || rawMatrix.length !== SECRET_MATRIX_SIZE) {

        return null;

    }

    const cells = [];

    for (const rawCell of rawMatrix) {

        if (typeof rawCell !== "string") {

            return null;

        }

        const cell = rawCell.toUpperCase();

        if (!SECRET_MATRIX_CELL_PATTERN.test(cell)) {

            return null;

        }

        cells.push(cell);

    }

    return cells;

}

export function isValidSecretMatrix(rawMatrix) {

    return normalizeSecretMatrix(rawMatrix) !== null;

}

export function secretMatrixKey(rawMatrix) {

    const cells = normalizeSecretMatrix(rawMatrix);

    return cells ? cells.join("") : null;

}

export function secretMatricesMatch(matrices) {

    if (!Array.isArray(matrices) || matrices.length === 0) {

        return false;

    }

    const keys = matrices.map((entry) => secretMatrixKey(entry));

    if (keys.some((key) => !key)) {

        return false;

    }

    return keys.every((key) => key === keys[0]);

}
