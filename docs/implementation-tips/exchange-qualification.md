# Exchange keeper pre-adoption qualification

TASK-139 qualified the prospective Exchange session mechanisms before ADR-0037 adoption. The probe ran on Darwin arm64 against the source-built Sorage CLI from `14cc7c2f09fb0625351125e1d4983a1f632689ee`, compiled with managed Bun 1.4.2. The compiled CLI SHA-256 was `1ab85a11a16dcbb32f4cdd80b5ba09c23e3e57bfc77abb5fdc18bc64a4bdbee0`. Test Projects, fixtures, homes, vaults and the prospective lease table were isolated. The keeper fixture did not implement Exchange's business operations.

## Native participation

| Harness mode | Observed communication and limits |
|---|---|
| Claude Code 2.1.329, actual Plan mode | STDIO MCP connected with native permission mode `plan`. An authorized synthetic Channel report was posted and recovered from the broker. A separate two-turn session posted and listed its fresh report through MCP. The first report was verified through a separate broker CLI readback. In the two-turn observation, both MCP results returned `ok: true` with no permission denials. The same open connection retained the same keeper after the first turn. Successful renewal count increased from 55 to 63 during a two-second wait and reached 119 after the second turn. EOF caused release and owner exit. Earlier Memo probes were declined by the model before it attempted the call; one still completed an actual Memo list. The harness did not reject a Memo write in either attempt. |
| Codex CLI 0.170.0, actual read-only sandbox | STDIO MCP Memo add and list returned `ok: true`, with the fresh synthetic record confirmed through the broker, both with the baseline server and with the keeper fixture. The instrumented connection recorded 52 successful renewals and a normal release and owner exit. |

The harnesses received session-only MCP configuration. They used no caller shell keeper or caller file writes. Protected caller files retained their checksums and the caller-workspace fixture inventories stayed unchanged. The native observations exercised existing Sorage operations through its published adapter plus a provisional keeper. TASK-142 repeats the mechanism checks with delivered Exchange operations, and TASK-146 qualifies the assembled candidate. The successful Plan-mode Channel observation supports communication on the observed setup; the unattempted Memo calls and other harnesses are outside that observed success.

## Owner and lifecycle

The prospective CLI owner is an explicit long-lived session process using a common renew and release CLI boundary. The MCP server's STDIO process starts and supervises a keeper, while the normal MCP adapter continues to invoke CLI children for accepted calls. The test fixture used a wrapper around the real adapter at the transport boundary to observe process ownership, and the delivered MCP process will own its keeper directly. The owner observes its connection or process lifetime; a live connection can survive a finished model turn, and its lease proves renewal by the owner, not current agent activity.

Separate MCP and CLI scenarios exercised idle wait, bounded long work, cancellation of one call while renewal continued, shutdown, keeper loss, expiry, replacement and refusal of an old claim. After tool cancellation the surviving MCP transport answered a subsequent ping. In the native two-turn run, Claude returned a turn result while the transport remained open and renewal continued. Explicit shutdown and EOF stopped the keeper and released its claim. The MCP transport remained responsive to a ping after its keeper child was killed. It did not auto-acquire a replacement. Forced owner loss left the current expiration unchanged, and the slot stayed unavailable before expiry. The successor could claim after expiry and refused renewal by the old claim.

Two failures informed the design. The first fixture reaped a killed keeper only when the transport ended. The next variant could allow a renewal child already waiting for the SQLite write lock to extend a lease after the owner was killed. The final fixture observed process exit promptly and checked owner and claim after acquiring the write lock. Killing the owner during a real held-lock test left the persisted expiry unchanged. The implementation must fence stale claims and observe owner loss at the bounded write boundary. A renewal already committing can race with shutdown; its recorded success sets the last expiry and never authorizes a replaced claim.

The fixture entry points were `owner` for the long-lived CLI process, `mcp` for the wrapper over native `sorage mcp`, and the shared `lease renew` and `lease release` operations. Native harness communication used the initial fixture at 250 ms renewal and a two-second lease. Its observed turn-survival window was two seconds, not a full selected lease. The corrected third fixture used 250 ms renewal and a two-second lease for short wait, cancellation and failure cases. The measured three-claim load and backup used four full cycles at 10-second renewal and a 40-second lease. Selected-setting owner loss used the same 40-second expiry.

In a separate native Codex read-only turn with the corrected third CLI owner fixture at the selected timing, the agent called the real CLI directly and read the exact synthetic Channel record. The turn completed while the same long-lived CLI owner remained live. Its successful renewal count increased from one to two, with the post-turn renewal observed about 8.17 seconds after completion at the selected 10-second cadence and 40-second lease. Explicit owner shutdown then released the claim. This verifies process ownership on the CLI path. The CLI call did not open a persistent MCP connection. The preceding attempt returned CLI usage exit 2 because the agent included trailing prompt punctuation. The scoped retry preserved native read-only policy and changed only the prompt framing.

## Timing and backup

A one-owner baseline over two 10-second renewal cycles and three simultaneous active claims in one Installation were measured. The three-claim topology represents the initial server and two clients and is the capacity basis of this qualification. The mixed run used one CLI owner and two MCP-owned keepers, the same isolated Sorage SQLite file for its expendable lease table, and a real transient SQLite writer lock. It also kept the baseline schema history at 12.

| Measurement | One claim | Three claims |
|---|---:|---:|
| Successful renewals | 2 | 12 |
| Missed renewals | 0 | 0 |
| Start, milliseconds | 71.59 | 74.7 to 155.7 |
| Worst renewal plus wake delay, milliseconds | 82.68 | 248.46 |
| Largest observed SQLite lock wait, milliseconds | — | 200.92 |
| Fixture renewal log growth, bytes | 693 | 4,284 |

Select a 10-second renewal interval and a 40-second lease. The highest measured renewal plus wake delay was below five seconds at the three-claim load. The lease expires before the separate five-minute incident threshold. At the selected setting, killed CLI and MCP owners did not renew. Replacement completed 173 ms and 260 ms after the respective expiry boundaries. Requalify timing when the intended concurrency, keeper or deployment changes. These values describe the isolated measurement, including probe logging, and do not guarantee production latency or log volume.

With zero pending filesystem recovery intents, renewal left all five canonical snapshot file hashes, the Vault HEAD and seven retained events unchanged. The actual Sorage backup returned `no-change`. The current schema is 12 and the canonical writer emits format 4. TASK-140 appends the initial Exchange schema 13 migration and introduces global format 5. The no-change observation does not establish the new snapshot's migration or restore behavior, which the owning implementing Tasks verify.

## Verification scope

This candidate adopts the canonical design and qualification evidence. It contains no product changes, migration or new runtime contract snapshot. Product tests require the implementations owned by later Tasks. TASK-139 uses the isolated mechanism observations above, the documentation and diff checks, and independent review of the adopted contract and migration classification.
