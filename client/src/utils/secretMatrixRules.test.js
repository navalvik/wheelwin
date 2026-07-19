import {
    isValidSecretMatrix,
    sanitizeSecretMatrixCell,
    SECRET_MATRIX_SIZE
} from "./secretMatrixRules.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

{

    assert(SECRET_MATRIX_SIZE === 9, "matrix size is 9");

    assert(
        isValidSecretMatrix(Array(9).fill("A")) === true,
        "complete valid matrix accepted"
    );

    assert(
        isValidSecretMatrix(Array(9).fill("")) === false,
        "empty matrix rejected"
    );

    assert(
        sanitizeSecretMatrixCell("ab") === "B",
        "sanitize keeps last valid char"
    );

    assert(
        sanitizeSecretMatrixCell("!") === "",
        "sanitize drops invalid input"
    );

    console.log("secretMatrixRules.test.js: all assertions passed");

}
