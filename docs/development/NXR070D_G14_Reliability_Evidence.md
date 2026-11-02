# G-14 reliability evidence from NXR-070D′

**Status: open. The cause is not proven, and the 5-second test deadline is unchanged.** The final three clean runs don't resolve it, because no long stall happened during them.

## The record

WSL Full failed 3 of 15 monitored or recorded runs on this branch. Each failure was a timeout at the 5-second limit in a different test file.

| Commit    | Result | Failed test and time                                               | Longest fsync per run         |
| --------- | ------ | ------------------------------------------------------------------ | ----------------------------- |
| `75833a3` | 2 of 3 | `sessions.test.ts`, 6,643 ms                                       | Monitor not running during it |
| `01c79c2` | 3 of 3 | None                                                               | 1,426, 367, 1,393 ms          |
| `79be762` | 2 of 3 | `project-memory.test.ts`, 5,603 ms                                 | 600–690 ms, repeated          |
| `00f530b` | 2 of 3 | 3 tests in `connection-manager.test.ts`, about 5,005–5,010 ms each | 221, 12,581, 103 ms           |
| `616042f` | 3 of 3 | None                                                               | 609, 628, 189 ms              |

## What the monitor showed

The monitor samples timer gaps, fsync latency, load and vitest processes inside the distribution.

- **`79be762`:** repeated 600–690 ms fsyncs at about 246–275 s coincided with the failing file at about 266 s. Timer gap 0, load below 2. Clean runs peaked at 203 and 176 ms.
- **`00f530b`:** a single 12,581 ms fsync stall at about 134 s on the monitor's clock coincided with the failing file. Timer gap 0, load 1.56.
- **`616042f`:** Windows disk samples ran every second alongside the three runs, and the longest fsync was 628 ms. Windows average write latency stayed at or below 52 ms during the runs. No failure happened to compare, so these samples neither support nor rule out a host cause.

## Conclusion

Failures line up strongly with disk stalls inside the VM. CPU starvation looks unlikely, since timer gaps stayed at 0 and load stayed low. **Why the disk stalls is unknown.** The cause could be the host, the virtual disk, or something else.

Two earlier passes with a 1.4 s fsync (`01c79c2`) show that a stall alone doesn't always fail a run. It depends on which test is running at that moment.

## Why the limit stayed

Raising it would hide an external stall without explaining it, and the assignment requires a separate evidence-backed correction. A correction needs proof of the stall's source.

## If it recurs

Keep the monitor and the host disk samples running, and preserve the `g14-*.ndjson` files and the host disk log. Timestamps in the host disk log are UTC. A failure with host samples is the missing evidence: a matching Windows latency spike points at the host, and no spike points inside the VM.
