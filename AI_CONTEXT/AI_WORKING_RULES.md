# WheelWin AI Working Rules

## 1. General Principle

AI agents working on WheelWin must preserve the existing architecture.

The goal is not to minimize code.

The goal is production reliability, correctness and maintainability.

Existing complexity may represent intentional domain separation.

---

# 2. Before Making Changes

Before modifying code:

1. Understand the current architecture.
2. Identify the responsible domain.
3. Find the existing owner of the state.
4. Verify current behaviour.
5. Propose the smallest required change.

Do not immediately implement.

---

# 3. Architecture Respect

Never:

- Rewrite existing architecture without approval.
- Replace managers with simplified versions.
- Move server logic into client.
- Duplicate existing systems.
- Create parallel recovery flows.
- Bypass existing validation.

Prefer:

- Existing modules.
- Existing EventBus communication.
- Existing lifecycle management.
- Minimal modifications.

---

# 4. Debugging Rules

When a problem appears:

First determine:

- Which domain owns the problem?
- Which module owns the state?
- Which event caused the transition?
- Where is the authoritative source?

Do not fix symptoms before understanding ownership.

---

# 5. Development Style

WheelWin development uses:

Small stages.

Each stage:

Analysis
> Implementation
> Validation
> Git commit

Large uncontrolled changes are forbidden.

---

# 6. Testing Requirements

Every change must consider:

- Existing multiplayer lifecycle.
- Server authority.
- Recovery behaviour.
- Financial correctness.
- Reconnect scenarios.

A solution that passes one test but violates architecture is unacceptable.

---

# 7. Financial Safety

Financial systems require additional caution.

Never:

- Fake payment state.
- Skip validation.
- Assume blockchain confirmation.
- Restore financial state from client data.

Financial truth must come from authoritative sources.

---

# 8. Communication Style

When working with WheelWin:

Explain:

- What will change.
- Why it is needed.
- Which module owns the change.
- What risks exist.

Do not hide architectural consequences.

---

# 9. Git Discipline

After every completed development stage:

Create Git checkpoint.

Format:

git add .
git commit -m "Stage description"
git push

---

# Final Rule

Protect the architecture first.

Improve implementation second.

Never sacrifice correctness for speed.