# Control security

QuantBot stores control intent and forwards commands to an explicitly designated strategy executor. The strategy applies its own local checks immediately before each operation. Entry permission changes affect only the strategy behavior defined by the control. Any liquidation action must be separately declared and authorized.

## Command lifecycle

| State | Meaning |
| --- | --- |
| created | The administrator's intent and idempotency key were persisted. |
| confirmation_required | A trusted administrator interface must confirm the request. All live actions and controls marked high, critical, or confirm require this step. |
| pending | The command is queued for one strategy, control revision, executor instance, and boot. |
| accepted | That executor acknowledged the offer under its current Agent session. |
| executing | QuantBot issued the only execution permit for the command. |
| succeeded / failed | The executor provided a verified outcome or an operator reconciled an unknown result with an explanation. |
| unknown | Execution may have occurred. Further commands for the same control are held pending reconciliation. |
| cancelled / expired / rejected | The operation ended before receiving a permit. |

All state transitions and corresponding audit events commit in one control database transaction. Command creation requires a declared writable control with available actual state, an online executor, and the current registry revision. The server repeats these checks on confirmation, acceptance and grant. Desired value and actual state are separately persisted. Receipts do not change actual state.

## Permit and recovery

The server commits the executing transition and a unique permit digest before returning the plaintext permit. A concurrent or repeated claim returns HTTP 409 without the permit. The Agent performs the action only after receiving the permit. Keep the command ID, granted permit and outcome in a private local durable journal. Apply the command ID as an idempotency key at the strategy or broker boundary where available.

If the claim response is lost, the executor does not have authority to perform the action. If a result response is lost, retry the saved result with the same permit and outcome. A lost execution result or interrupted execution is marked unknown at deadline or service recovery. Unknown commands stay out of polling and cannot acquire another permit. A verifiable late receipt can reconcile them. An administrator can also reconcile an unknown command after checking broker and strategy records.

The platform can fence Agent sessions and prevent duplicate grants. A grant already received cannot be recalled from an external process. The executor must honor its deadline and local safety checks and avoid interpreting network errors as authorization to run a command again.
