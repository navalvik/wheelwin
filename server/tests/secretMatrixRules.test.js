import {
    isValidSecretMatrix,
    normalizeSecretMatrix,
    secretMatricesMatch,
    secretMatrixKey,
    SECRET_MATRIX_SIZE
} from "../models/SecretMatrixRules.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

{

    assert(SECRET_MATRIX_SIZE === 9, "matrix size is 9");

    assert(
        isValidSecretMatrix(["A", "B", "C", "1", "2", "3", "X", "Y", "Z"]) === true,
        "valid matrix accepted"
    );

    assert(
        isValidSecretMatrix(["A", "B", "C", "1", "2", "3", "X", "Y"]) === false,
        "short matrix rejected"
    );

    assert(
        isValidSecretMatrix(["A", "B", "C", "1", "2", "3", "X", "Y", "!"]) === false,
        "invalid cell rejected"
    );

    assert(
        isValidSecretMatrix(["a", "b", "c", "1", "2", "3", "x", "y", "z"]) === true,
        "lowercase normalized"
    );

    assert(
        normalizeSecretMatrix(["a", "b", "c", "1", "2", "3", "x", "y", "z"]).join("")
            === "ABC123XYZ",
        "normalize uppercases"
    );

    assert(
        secretMatrixKey(["A", "B", "C", "1", "2", "3", "X", "Y", "Z"]) === "ABC123XYZ",
        "key joins cells"
    );

    assert(
        secretMatricesMatch([
            ["A", "1", "B", "2", "C", "3", "D", "4", "E"],
            ["A", "1", "B", "2", "C", "3", "D", "4", "E"],
            ["A", "1", "B", "2", "C", "3", "D", "4", "E"]
        ]) === true,
        "matching matrices pass"
    );

    assert(
        secretMatricesMatch([
            ["A", "1", "B", "2", "C", "3", "D", "4", "E"],
            ["A", "1", "B", "2", "C", "3", "D", "4", "E"],
            ["Z", "1", "B", "2", "C", "3", "D", "4", "E"]
        ]) === false,
        "mismatch rejected"
    );

    console.log("secretMatrixRules.test.js: all assertions passed");

}
