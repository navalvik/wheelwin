/**
 * R7.0D — Console (stdout/stderr) transport.
 */

export class ConsoleTransport {

    constructor({ formatter }) {

        this._formatter = formatter;

        this._enabled = true;

    }

    write(record) {

        if (!this._enabled) {

            return;

        }

        const stream = record.level === "error" || record.level === "fatal" || record.level === "warn"
            ? process.stderr
            : process.stdout;

        stream.write(this._formatter.format(record));

    }

    setEnabled(enabled) {

        this._enabled = enabled === true;

    }

    flush() {

        // streams are sync enough for process exit

    }

}
