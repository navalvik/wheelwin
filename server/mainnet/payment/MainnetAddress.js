import { Address } from "@ton/core";
import { deriveTonAddressIdentity } from "../../payment/incoming/TonAddressIdentity.js";

export function mainnetAddressIdentity(value) {
    const identity = deriveTonAddressIdentity(value);
    if (/^[A-Za-z0-9_-]{48}$/.test(value)
        && Address.parseFriendly(value).isTestOnly) {
        throw new Error("MAINNET_TESTNET_TAGGED_ADDRESS_REJECTED");
    }
    return identity;
}
