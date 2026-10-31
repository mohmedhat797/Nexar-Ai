# ADR-030 dependency security amendment: exact overrides for DSH 0.2.1-rc.3

- Superseded as the current override set by the [rc.5 dependency amendment](030-dependency-security-amendment-dsh-021-rc5.md), 31 October 2026.
- Authorization: project owner, NEXAR engineering stabilization assignment, 30 October 2026: "narrowly scoped transitive dependency correction" with documented artifact identity.
- Status: implemented on `feat/nxr-dsh-021-rc3-upgrade`. Integration still requires independent owner acceptance.
- Amends: [ADR-030 version amendment](030-version-amendment-dsh-021-rc3.md). The exact package remains `@deepseek-ai/dsh@0.2.1-rc.3`; only the listed transitive packages move.

## Decision

The managed runtime applies these exact npm `overrides`, recorded in `integrations/deepseek-harness/dsh-runtime.json` and reflected in `dsh-runtime.package-lock.json`:

| Package                        | Locked before             | Locked now | Corrects                                              |
| ------------------------------ | ------------------------- | ---------- | ----------------------------------------------------- |
| `zod`                          | 4.4.3 (50 nested) + 4.6.7 | 4.6.7      | GHSA-mrhx-c7xc-m3w5                                   |
| `undici`                       | 8.11.2                    | 8.12.3     | GHSA-xjj6-f33q-929c, -4qv8-2p9j-2685, -f72v-6w45-q472 |
| `fflate`                       | 0.8.2 (nested) + 0.8.3    | 0.8.3      | GHSA-px8p-9vwx-vf98                                   |
| `@modelcontextprotocol/client` | 2.2.0                     | 2.3.1      | GHSA-6prh-2h8m-c8cw                                   |
| `@modelcontextprotocol/core`   | 2.2.0                     | 2.3.1      | Required exact companion of the client                |

No other package version changed. The installer accepts only exact names and exact versions in `overrides`; a range fails as `INVALID_PIN`. There is no `npm audit fix`, no automatic update and no authorization to change this set without another amendment.

## Consequences

- The runtime is no longer byte-equivalent to upstream's own resolution of rc.3. Its identity is the pin **plus** this lock; the upstream root tarball identity is unchanged.
- This removes the 50 nested Zod copies, which were 35,900 of the 63,785 materialized files. That changes install timing, but the 180-second installer policy is unchanged.
- Upstream declares these as exact dependencies, so compatibility is Nexar's verified claim, not upstream's. Each override must be re-evaluated, and removed where possible, on any future DSH version change.
- Rollback to the previous lock is a source revert plus a fresh managed installation.

The advisory register, reachability and evidence are in [the dependency security assessment](../development/NXR070_DSH_RC3_Dependency_Security_Assessment.md).
