# Next native-runtime cutover

This is **not an ordinary Worker deploy**. Cloudflare's container scheduling policy
is immutable and its replacement requires a new Durable Object namespace.
The approved Next testing reset replaces `ComputerThread` with `NativeThread`,
deletes the old namespace, and discards existing test threads. Account credentials
remain in `ComputerCredentials`. The original production `ThreadSandbox` is unaffected.
Never apply this destructive reset to an installation with work to preserve.

## Before touching the running application

1. Stop accepting new Next work and let current turns finish. Record every Next
   thread's owner, DO identity, checkpoint pointer and last successful save time.
2. Export and verify a fresh `/workspace` archive and matching conversation from
   every live workspace using the existing runtime. The old Artifacts error must
   not be treated as a successful save. If any workspace has only live disk or
   Computer's incremental SQLite filesystem, preserve/export it before proceeding.
3. Validate archive extraction, Git state and canonical Codex rollouts against a
   disposable container. Keep current and previous backups. Do not delete D1 rows,
   DO storage, R2 objects or the account credential DO.
4. If even one workspace cannot be exported, stop the cutover. Do not deploy the
   native image over the old FUSE image and hope its filesystem carries over.

## Approved cutover and canary

Follow Cloudflare's [scheduling-policy migration guide](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/)
to replace **only** the Next ComputerThread container application. A new namespace
is required; preserving work instead requires an explicit export/import process.
For the approved disposable-testing reset, remove old Next thread records and
delete the old container application before deploying migration `v3-native-runtime`.
Deploy the matching Worker and named `workspace` image. Do not run this against
`agentflare-web` or its shared sandbox application.

Before reopening work, verify on a disposable Next thread:

- `/run` is tmpfs; source, ignored files and rollouts are ordinary native disk.
- A turn stays alive with the browser closed, through a DO restart.
- A native snapshot restores files without credentials or stale bridge processes.
- An R2 checkpoint restores before Codex starts, including with an updated image.
- Idle suspend followed by a new message restores and sends that message once.
- Failed archive/snapshot/restore requests preserve the last committed backup;
  an interrupted prompt is never replayed.
- Confirm existing exported threads restore from their R2 checkpoint and that the
  first native checkpoint is committed before removing the maintenance gate.

Snapshots are filesystem-only, expire after 30 days without restore, and cannot
be deleted through the current Worker API. Keep R2 free of expiry rules. Rolling
back Worker code alone does not reverse the scheduling-policy migration; preserve
the verified archives and plan another explicit container-application cutover.
