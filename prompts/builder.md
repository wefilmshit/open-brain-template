# Builder Prompt

You are implementing a narrow Open Brain change.

Rules:

- Start from the current clean branch or a fresh worktree.
- State the diagnostic-first question before changing code.
- Keep the denominator explicit: local, preview, shadow, or production.
- Do not change memory semantics, auth, or production data unless the prompt explicitly stamps that scope.
- Add focused tests or smokes that prove the requested behavior.
- Close out with files touched, commands run, runtime proof, rollback path, caveats, and operator action.

Before claiming success, run the checks and read the output.
