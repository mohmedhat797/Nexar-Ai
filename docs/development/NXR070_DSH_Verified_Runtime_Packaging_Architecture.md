# DSH verified runtime packaging architecture

Date: 30 October 2026. Implementation: `ab1dddae4f9147932a91d60fc49085b82d808b8b`, tree `87a8c0eeffde132029561f762ceb17f69846d52b`. **Verdict: NEXAR_DSH_RC3_PACKAGING_VERIFIED.**

## Original sequence and the redundant installation

Full CI installed the runtime in `dsh-install`, tested it, then `package-win.mjs` deleted `dist/dsh-runtime` and ran the installer again. Nothing connected the two trees, so the runtime that shipped was never the one tested, and packaging carried a second exposure to the 180-second deadline. That second `npm ci` is what failed on 27 October.

## What the timeout evidence does and does not show

The failed tree held 62,833 of 63,785 files, so npm was about 98.5% done at the deadline. A bounded differential on 30 October, same disk and warm cache, after cleanup:

| Lock                    | Files  | Run 1  | Run 2  |
| ----------------------- | ------ | ------ | ------ |
| Original rc.3           | 63,785 | 64.2 s | 66.5 s |
| With security overrides | 27,872 | 43.4 s | 44.4 s |

The original lock now completes in about a third of the deadline on the volume where it timed out. So file count alone did not cause the timeout. The capacity preflight of the failed run recorded 2.2 GB free on that volume, against about 40 GB today, and the 27 October ENOSPC failure is on the same volume. That is a strong correlation, **not a demonstrated mechanism**: low free space was not deliberately reproduced, and Defender, fragmentation and other load were not isolated. The historical cause stays formally unresolved.

Measurably corrected: the redundant installation is gone from the CI path, capacity headroom was restored, and materialized files fell 56%.

## Design

```text
exact pin + lock → accepted installer → install receipt → seal (tree digest)
                                                             │
          package-win: verify identity, copy while hashing ──┘
                                │
          digest match → rename into dist/dsh-runtime → version probe
                                │
          electron-builder → hash win-unpacked runtime against seal → provenance record
```

`scripts/dsh-runtime/artifact.mjs` owns this. The installer's 180-second deadline, admission lock, staging, entrypoint and version checks and publication are unchanged.

**Install receipt.** Written into the stage only after the entrypoint and CLI version checks pass, immediately before publication. A failed or partial stage never has one, so only a tree the accepted installer completed can be sealed.

**Seal.** `nexar-runtime-artifact.json` binds package, version, lock SHA-256, platform, architecture, install and seal generations, file and byte counts, and a tree digest over every file's relative path, size and SHA-256. Sealing is a separate step and CI stage, because hashing must not consume the installer's deadline. In CI it runs directly after installation, so a later mutation by tests breaks the seal rather than being sealed in.

**Completeness.** npm writes `node_modules/.package-lock.json` last. Each entry must match the pinned lock's version and integrity and exist on disk, and each required pinned package must be present.

**Promotion.** Each file is hashed from the same read that writes it, into a uniquely named stage. A file altered after the seal or during the copy cannot publish. The stage is renamed into place only after the whole digest matches.

**Links.** Any symlink or junction anywhere in the tree refuses the artifact. The measured rc.3 Windows tree has none. A runtime path that resolves through a linked ancestor is also refused.

**Packaged verification.** After electron-builder, the runtime in `win-unpacked` is hashed against the seal. Any difference fails packaging and names the affected files. Only `runtime.json`, the seal and the receipt are excluded, as per-generation metadata.

## Modes

| Mode | Condition                   | Behavior                                                          |
| ---- | --------------------------- | ----------------------------------------------------------------- |
| A    | Valid seal                  | Verified promotion; npm is not involved                           |
| B    | No directory, or no seal    | Accepted installer into `dist/dsh-runtime`, then sealed           |
| C    | A seal that does not verify | Fails closed; only `--fresh-dsh-runtime` overrides it             |
| D    | Interrupted promotion       | Unreferenced `.promote-<uuid>` stage; the target is never created |

The default source is the checkout's `.nexar/dsh-runtime`. `--runtime-artifact=<dir>` lets local CI name the runtime its own install stage produced. The path grants nothing, since content verification decides, and it is an argument rather than an environment variable.

A packaging lock admits one run per checkout. After a hard kill it remains and the next run fails closed, because PIDs can be reused. `pnpm dsh:runtime` installs and seals for standalone use.

## Security limits

The seal detects corruption, partial trees, stale versions and accidental or post-install modification. **It is not a signature.** A process running as the same user could rewrite the tree and the seal together, but that process could equally rewrite the source or the builder, and defending against it was already out of scope. Content integrity against the registry is still established by `npm ci`'s lock integrity at install time.

## Real verification

| Check                                          | Result                                                 |
| ---------------------------------------------- | ------------------------------------------------------ |
| Promotion of the real runtime                  | 42 s; 27,872 files                                     |
| Independent installation of the same lock      | Identical digest `d40e76a3…`                           |
| One changed byte; forged tree digest           | `ARTIFACT_TREE_MISMATCH`; nothing published            |
| Wrong version; wrong lock in seal              | `ARTIFACT_IDENTITY_MISMATCH`; `ARTIFACT_LOCK_MISMATCH` |
| Missing hidden lockfile                        | `ARTIFACT_INCOMPLETE`                                  |
| Installation lock present                      | `ARTIFACT_INSTALLATION_ACTIVE`                         |
| Concurrent packaging                           | Refused; existing lock retained                        |
| Mode A real package (standalone, then Full CI) | PASS; packaged digest equals seal                      |
| Mode B real package                            | PASS in 910 s                                          |

Unit coverage: `tests/dsh-runtime-artifact.test.ts` (19) and additions to `tests/dsh-runtime-install.test.ts`, including receipt absence after a failed version probe, interrupted promotion, junctions and path aliases.

## Honest assessment of the benefit

Reuse does not make packaging faster now: promotion takes 42 s and a fresh install 42 s. Its value is that the shipped bytes are provably the tested bytes, and packaging no longer depends on npm, the registry or the 180-second deadline.

## Remaining limits

- **The package stage has thin margin.** Observed: 910 s, 1,324 s, 1,692 s against the unchanged 1,500 s envelope. The 1,692 s run, the first standalone one, would have exceeded it; its phases were not recorded and it downloaded Electron. In the timed run electron-builder took 766 s, about 9 minutes of it NSIS compression. This needs its own investigation; the envelope was not raised.
- **The NSIS payload was not independently extracted.** The bundled `7za` lacks the NSIS format, and a silent install could affect the owner's real installation. Packaged E2E and digest verification run on `win-unpacked`, the input to NSIS. No clean-machine installation is claimed.
- `.previous-<uuid>` generations accumulate per install by design; see workspace maintenance.
