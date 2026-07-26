/**
 * R8.0D — Invitation / registration / approval registry (no PII wallets).
 */

import {
    PARTICIPANT_APPROVAL
} from "./BetaConfiguration.js";
import {
    createBetaParticipant,
    withParticipantPatch
} from "./models/BetaParticipant.js";

export class BetaParticipantRegistry {

    /**
     * @param {{ maxParticipants?: number }} [options]
     */
    constructor(options = {}) {

        this._max = options.maxParticipants ?? 500;

        /** @type {Map<string, ReturnType<typeof createBetaParticipant>>} */
        this._byId = new Map();

        /** @type {Map<string, string>} invitationCode → id */
        this._byInvite = new Map();

    }

    clear() {

        this._byId.clear();

        this._byInvite.clear();

    }

    count() {

        return this._byId.size;

    }

    list() {

        return [...this._byId.values()];

    }

    get(id) {

        return this._byId.get(id) ?? null;

    }

    /**
     * @param {{
     *   invitationCode?: string,
     *   displayLabel?: string,
     *   tags?: string[]
     * }} input
     */
    invite(input = {}) {

        if (this._byId.size >= this._max) {

            throw new Error("Closed Beta participant limit reached");

        }

        const code = input.invitationCode
            ? String(input.invitationCode).slice(0, 64)
            : `INV-${Date.now().toString(36)}-${this._byId.size + 1}`;

        if (this._byInvite.has(code)) {

            throw new Error("Invitation code already exists");

        }

        const participant = createBetaParticipant({
            invitationCode: code,
            displayLabel: input.displayLabel,
            tags: input.tags,
            approvalStatus: PARTICIPANT_APPROVAL.INVITED
        });

        this._byId.set(participant.id, participant);

        this._byInvite.set(code, participant.id);

        return participant;

    }

    /**
     * @param {string} invitationCode
     * @param {{ displayLabel?: string }} [opts]
     */
    register(invitationCode, opts = {}) {

        const id = this._byInvite.get(String(invitationCode));

        if (!id) {

            throw new Error("Unknown invitation code");

        }

        const existing = this._byId.get(id);

        if (!existing) {

            throw new Error("Unknown participant");

        }

        if (existing.approvalStatus === PARTICIPANT_APPROVAL.REVOKED) {

            throw new Error("Invitation revoked");

        }

        const updated = withParticipantPatch(existing, {
            approvalStatus: PARTICIPANT_APPROVAL.PENDING,
            registeredAt: Date.now(),
            displayLabel: opts.displayLabel ?? existing.displayLabel,
            lastActivityAt: Date.now()
        });

        this._byId.set(id, updated);

        return updated;

    }

    approve(participantId) {

        return this._setStatus(participantId, PARTICIPANT_APPROVAL.APPROVED, {
            approvedAt: Date.now()
        });

    }

    activate(participantId) {

        return this._setStatus(participantId, PARTICIPANT_APPROVAL.ACTIVE, {
            activatedAt: Date.now(),
            lastActivityAt: Date.now()
        });

    }

    suspend(participantId) {

        return this._setStatus(participantId, PARTICIPANT_APPROVAL.SUSPENDED);

    }

    revoke(participantId) {

        const existing = this._byId.get(participantId);

        if (!existing) {

            throw new Error("Unknown participant");

        }

        if (existing.invitationCode) {

            this._byInvite.delete(existing.invitationCode);

        }

        return this._setStatus(participantId, PARTICIPANT_APPROVAL.REVOKED);

    }

    touchActivity(participantId) {

        const existing = this._byId.get(participantId);

        if (!existing) {

            return null;

        }

        const updated = withParticipantPatch(existing, {
            lastActivityAt: Date.now()
        });

        this._byId.set(participantId, updated);

        return updated;

    }

    summary() {

        const counts = {
            invited: 0,
            pending: 0,
            approved: 0,
            active: 0,
            suspended: 0,
            revoked: 0,
            total: this._byId.size
        };

        const byTag = Object.create(null);

        for (const p of this._byId.values()) {

            const key = String(p.approvalStatus).toLowerCase();

            if (key in counts) {

                counts[key] += 1;

            }

            for (const tag of p.tags) {

                byTag[tag] = (byTag[tag] ?? 0) + 1;

            }

        }

        return Object.freeze({
            ...counts,
            byTag: Object.freeze({ ...byTag })
        });

    }

    /**
     * Safe list for console / health (no invitation codes).
     */
    getSafeList() {

        return this.list().map((p) => Object.freeze({
            id: p.id,
            displayLabel: p.displayLabel,
            tags: p.tags,
            approvalStatus: p.approvalStatus,
            invitedAt: p.invitedAt,
            registeredAt: p.registeredAt,
            approvedAt: p.approvedAt,
            activatedAt: p.activatedAt,
            lastActivityAt: p.lastActivityAt
        }));

    }

    _setStatus(participantId, approvalStatus, extra = {}) {

        const existing = this._byId.get(participantId);

        if (!existing) {

            throw new Error("Unknown participant");

        }

        const updated = withParticipantPatch(existing, {
            approvalStatus,
            ...extra,
            lastActivityAt: Date.now()
        });

        this._byId.set(participantId, updated);

        return updated;

    }

}
