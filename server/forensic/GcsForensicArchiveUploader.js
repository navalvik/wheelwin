/**
 * R13.9F — Historical GCS uploader (superseded by R2ForensicArchiveUploader in R13.9H).
 * Kept as reference only; not wired into app.js.
 * Runtime GCS dependency (@google-cloud/storage) was removed in R13.9H.
 *
 * @deprecated R13.9H — use R2ForensicArchiveUploader instead.
 */
export class GcsForensicArchiveUploader {

    constructor() {

        throw new Error(
            "GcsForensicArchiveUploader is deprecated; use R2ForensicArchiveUploader"
        );

    }

}
