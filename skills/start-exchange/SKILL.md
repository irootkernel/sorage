---
name: start-exchange
description: Use when the user explicitly asks to create a Sorage Exchange for registered Projects and join it as the opening Project.
---

# Start an Exchange

Read [references/exchange-loop.md](references/exchange-loop.md) from this skill directory before calling Sorage. If the reference is missing or unreadable, stop the dependent operation and report the incomplete copy.

Resolve the intended Installation, acting registered workspace, goal, at least one peer Project, and at least one completion criterion from the user's request. Use the common transport selection in the reference. Keep one operation ID and the exact creation inputs. On MCP call `exchange_create` with `cwd`, `operationId`, `goal`, `member` and `criterion`. Both `member` and `criterion` are nonempty string arrays. On CLI use `sorage exchange create --goal <goal> --member <peer> --criterion <criterion> --operation-id <id> --json` from the acting workspace. Repeat the member and criterion options as needed. The broker includes the opening Project in the roster.

Report the exact returned `exchangeId` to the user as soon as creation succeeds, before joining. Creation gives no participant claim. If its result is uncertain, use the exact creation recovery path in the reference. Keep a known ID if join fails. Continue through the reference's common join procedure with that ID and the opening Project, then carry out only the requested participation.
