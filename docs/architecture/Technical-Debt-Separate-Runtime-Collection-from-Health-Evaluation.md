# Known Technical Debt — Separate Runtime Collection from Health Evaluation

**Status:** Known Technical Debt (not a release blocker)  
**Stabilization window:** Release Stabilization (post R9.0C)  
**Date recorded:** 2026-07-26  
**Risk while deferred:** Low (mitigated by reentrancy guard)

---

## Summary

`HealthService.getHealthSnapshot()` resolves `runtime` via `WheelWinApplication._collectRuntime()`.  
`_collectRuntime()` also refreshes observational statuses (`launch` / `GA` / `operations` / `governance`) by calling `getSafeStatus()`.  
Those managers evaluate using a `healthSnapshot` provider that calls `getHealthSnapshot()` again.

This forms a proven circular dependency:

```text
getHealthSnapshot
  → _collectRuntime
    → getSafeStatus(*)
      → healthSnapshot provider
        → getHealthSnapshot
```

---

## Current mitigation (release-safe)

| Stabilization | Location | Role |
|---------------|----------|------|
| Socket.IO options clone | `SocketGateway.initialize` | Mutable copy for Socket.IO; runtime config stays deep-frozen |
| Sync log flush on startup failure | `application.start().catch` | Surfaces startup errors before `process.exit` |
| `_collectRuntime` reentrancy guard | `WheelWinApplication._collectRuntime` | Breaks recursive stack; **does not remove the cycle** |

Gameplay lifecycle, networking authority, payment/settlement, and immutable `RuntimeConfiguration` are unchanged.

---

## Future refactoring (do not implement in Release Stabilization)

**Title:** Separate Runtime Collection from Health Evaluation

**Intent:** Restore a single responsibility for `_collectRuntime` and eliminate the health-evaluation cycle.

**Minimal architectural steps (future stage):**

1. `_collectRuntime` returns **counts only** (rooms, games, sockets, timers, etc.).
2. Observational status refresh moves **outside** snapshot assembly (explicit refresh before `/health`, or startup wiring only).
3. Optional: managers’ `healthSnapshot` provider uses a **lite** snapshot that does not resolve `runtime`.

**Constraints to preserve:**

- Server Authoritative architecture
- Immutable `RuntimeConfiguration` / `deepFreeze`
- SocketGateway clone boundary for Socket.IO
- Observational-only launch / GA / ops / governance layers

**Recommended stage:** Post-stabilization maintenance / R9.1+ observability hygiene (not a GA gameplay stage).

---

## Acceptance criteria for the future fix

- No reentrancy guard required for correctness
- `/health` remains stable under concurrent probes
- Launch / GA / ops / governance evaluation no longer re-enter full snapshot assembly
- Monitoring gauges remain deterministic
- No gameplay or payment path changes
