# ADR-030 dependency security amendment: exact overrides for DSH 0.2.1-rc.5

- Authorization: project owner, 31 October 2026, NEXAR DSH Upgrade Scope Amendment: fresh assessment, each override reviewed individually, no broad upgrades.
- Status: implemented on `feat/nxr-dsh-021-rc3-upgrade`. Integration still requires independent owner acceptance.
- Replaces: [rc.3 dependency amendment](030-dependency-security-amendment-dsh-021-rc3.md) as the current override set.

## Decision

The managed runtime applies these exact npm `overrides`, recorded in `integrations/deepseek-harness/dsh-runtime.json` and reflected in `dsh-runtime.package-lock.json`:

| Package                        | Locked without override | Locked now | Advisories corrected                                                                                                                       |
| ------------------------------ | ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `zod`                          | 4.4.3 (50 nested)       | 4.6.7      | GHSA-mrhx-c7xc-m3w5                                                                                                                        |
| `undici`                       | 8.11.2                  | 8.12.3     | GHSA-xjj6-f33q-929c, -4qv8-2p9j-2685, -f72v-6w45-q472, -4w7w-5xrc-9h26, -2m5v-pch6-74hx, -qrxm-fqhp-jwvm, -9fm3-97px-rjf6, -55wc-3pg8-jfw6 |
| `fflate`                       | 0.8.2                   | 0.8.3      | GHSA-px8p-9vwx-vf98                                                                                                                        |
| `@modelcontextprotocol/client` | 2.2.0                   | 2.3.1      | GHSA-6prh-2h8m-c8cw                                                                                                                        |

The `@modelcontextprotocol/core` override from rc.3 is removed: dropping it leaves an identical lock tree. Dropping any of the other four brings its advisories back. There was no `npm audit fix`, and the installer still rejects non-exact overrides as `INVALID_PIN`.

## Consequences

- The runtime is not byte-equivalent to upstream's own resolution of rc.5. Its identity is the pin plus this lock.
- Upstream declares these as exact dependencies, so compatibility is Nexar's verified claim. One owner-run DeepSeek check exercised it through the adapter; see the [delta report](../development/NXR070_DSH_RC5_Compatibility_and_Upgrade_Delta.md#real-provider-check).
- The rc.3 record listed six advisories, but the same data has eleven. See the correction in the [delta report](../development/NXR070_DSH_RC5_Compatibility_and_Upgrade_Delta.md).
- Re-evaluate each override on any DSH version change, and remove it where upstream has moved past it.
