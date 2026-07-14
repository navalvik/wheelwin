import {
    isAuthoritativePaymentComplete,
    mapAuthoritativePaymentToContractLabel,
    mapAuthoritativePaymentToRowStatus,
    shouldShowPaymentWaiting
} from "./authoritativePaymentView.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

{

    assert(
        mapAuthoritativePaymentToRowStatus(null) === null,
        "missing payment must not invent a row status"
    );

    assert(
        shouldShowPaymentWaiting(false, null) === true,
        "waiting when players are missing"
    );

    assert(
        shouldShowPaymentWaiting(true, null) === true,
        "waiting when payment has not arrived"
    );

    assert(
        isAuthoritativePaymentComplete(null) === false,
        "must not auto-complete missing payment"
    );

    assert(
        mapAuthoritativePaymentToContractLabel(null)
            === "WAITING FOR PAYMENT…",
        "contract banner waits when payment missing"
    );

    console.log("  empty / waiting guards passed");

}

{

    assert(
        mapAuthoritativePaymentToRowStatus({ status: "STARTED" }) === "pending",
        "STARTED maps to pending"
    );

    assert(
        mapAuthoritativePaymentToRowStatus({ status: "COMPLETED" })
            === "confirmed",
        "COMPLETED maps to confirmed"
    );

    assert(
        mapAuthoritativePaymentToRowStatus({ status: "FAILED" }) === "failed",
        "FAILED maps to failed"
    );

    assert(
        isAuthoritativePaymentComplete({ status: "COMPLETED" }) === true,
        "COMPLETED enables next"
    );

    assert(
        isAuthoritativePaymentComplete({ status: "STARTED" }) === false,
        "STARTED does not enable next"
    );

    assert(
        shouldShowPaymentWaiting(true, { status: "STARTED" }) === false,
        "rows show once payment status arrives"
    );

    assert(
        mapAuthoritativePaymentToContractLabel({ status: "COMPLETED" })
            === "SMART CONTRACT IS CONFIRMED",
        "contract label follows authoritative COMPLETED"
    );

    console.log("  authoritative payment mapping passed");

}

console.log("authoritativePaymentView.test.js: all assertions passed");
