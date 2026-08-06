/// R7.66A — GameEscrow Tact skeleton.
/// No stake / settle / cancel logic yet. Toolchain + deterministic code artifact only.

contract GameEscrow {
    /// Placeholder storage bit so the contract is a valid empty state machine.
    deployed: Bool;

    init() {
        self.deployed = true;
    }

    /// Accept empty messages (deploy / bounce-safe placeholder).
    receive() {
        // intentionally empty — R7.66A skeleton
    }

    get fun isDeployed(): Bool {
        return self.deployed;
    }
}
