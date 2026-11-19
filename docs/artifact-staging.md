# Project artifact transactions

The installer prepares project artifacts through `src/artifact-stage.mjs`. The module has no third-party dependencies and keeps preview plans and rollback journals in private host storage outside the target worktree. It does not create commits or publish changes.

## Preview and apply

Call `stageArtifacts({ root, artifacts, stateDirectory })` with an existing project directory, an object mapping repository-relative paths to text, and a private staging directory. Use `null` as an artifact's value to propose deletion. The returned plan contains an opaque `id` and a `changes` array with each path's `before` and `after` text. Show those changes to the operator before calling `applyArtifacts({ root, stateDirectory, id })` for that exact plan.

Preview reads the target without changing it. The staging directory must be outside the project, owned by the current user, and inaccessible to other users. All artifact paths must be relative, without parent traversal, symbolic links, or Git metadata. Unknown project files are left alone. Plans with overlapping file and directory paths are rejected.

Application checks every target snapshot before writing. An intervening target edit rejects the plan; prepare and review a fresh preview. Existing file permissions are preserved. New files use mode 644. Successful repeated application of the same plan produces an empty `changes` array, provided the applied files still match. Repeated staging of an unchanged result also produces no changes.

## Failure and recovery

Before each mutation, application records rollback intent durably in a private journal. Default file writes use a temporary file and atomic rename. A failed application restores the original file contents and removes empty directories created by the transaction. An optional asynchronous `writeFile(path, content)` argument on `applyArtifacts` supports controlled write-failure injection; it does not change the journal protocol.

If a process exits before rollback completes, keep its plan and journal and call `recoverArtifacts({ root, stateDirectory, id })`. Recovery refuses to interrupt a live transaction. After confirming that a recorded lock's process no longer exists, it restores the interrupted transaction's original contents. Recovery rejects conflicting subsequent edits rather than overwriting them. Inspect and reconcile any reported conflict before retrying. A completed or already rolled-back transaction needs no recovery.

After successful recovery, the same reviewed plan can be applied again while its original snapshots still match. Keep journals until the caller has confirmed success and no recovery is needed. Installer cleanup must preserve publishing credentials and operational state stored elsewhere; only completed artifact transaction staging is disposable.

This module coordinates local processes sharing one staging directory. Filesystem checks reject existing symbolic links, but the module is not an operating-system sandbox against another process maliciously replacing paths during a transaction. Use a trusted local checkout and a single coordinating host.
