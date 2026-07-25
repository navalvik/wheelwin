/**
 * R7.0D — JSON log line formatter.
 */

export class JsonFormatter {

    format(record) {

        return `${JSON.stringify(record)}\n`;

    }

}
