/**
 * R7.0H — Base validation scenario.
 */

export class ValidationScenario {

    /**
     * @param {{
     *   id: string,
     *   name: string,
     *   description?: string
     * }} options
     */
    constructor({ id, name, description = "" }) {

        this.id = id;

        this.name = name;

        this.description = description;

    }

    /**
     * @param {import("./ValidationAssertions.js").ValidationAssertions} assert
     * @param {object} context
     * @returns {Promise<object|void>}
     */
    async run(_assert, _context) {

        throw new Error(`Scenario ${this.id} must implement run()`);

    }

}
