export const SECRET_MATRIX_SIZE = 9;

export const SECRET_MATRIX_CELL_PATTERN = /^[A-Z0-9]$/;

/**
 * Client mirror of server SecretMatrixRules.
 * NEXT stays disabled while this returns false.
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

export function sanitizeSecretMatrixCell(rawValue) {

    if (typeof rawValue !== "string") {

        return "";

    }

    return rawValue
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(-1);

}
