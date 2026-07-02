export class Player {

    static fromParts(identity, runtime) {

        return {
            identity: identity.toSnapshot(),
            runtime: runtime.toSnapshot()
        };

    }

}
