/**
 * R7.0C — Owner configuration file schema.
 */

export const OWNER_SCHEMA = Object.freeze({
    path: Object.freeze({
        key: "owner.json",
        type: "file",
        required: true,
        category: "Payments",
        suggestedFix: "Copy config/owner.example.json to config/owner.json and set ownerWallet."
    }),
    ownerWallet: Object.freeze({
        key: "ownerWallet",
        type: "tonAddress",
        required: true,
        category: "Payments",
        suggestedFix: "Set ownerWallet to a valid TON address in config/owner.json."
    })
});
