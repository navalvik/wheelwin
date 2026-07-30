/**
 * R7.0C — Owner configuration file schema.
 */

export const OWNER_SCHEMA = Object.freeze({
    path: Object.freeze({
        key: "owner.json",
        type: "file",
        required: true,
        category: "Payments",
        suggestedFix: "Copy config/owner.example.json to config/owner.json and set ownerWallet, or set OWNER_WALLET."
    }),
    ownerWallet: Object.freeze({
        key: "ownerWallet",
        type: "tonAddress",
        required: true,
        category: "Payments",
        suggestedFix: "Set OWNER_WALLET or ownerWallet in config/owner.json to a valid TON address."
    })
});
