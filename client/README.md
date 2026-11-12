# quantbot-client

Connect a Python trading program to [QuantBot](https://github.com/yaho7/QuantBot). One file, standard library only.

```bash
uv add "quantbot-client @ git+https://github.com/yaho7/QuantBot#subdirectory=client"
```

```python
from quantbot_client import QuantBot

qb = QuantBot("momentum")
with qb:
    while not qb.stopping:
        ...  # one round of trading
        qb.status("净值 10000")
        if not qb.sleep(60):
            break
```

Running `quantbot link` in your project does all of this for you.

## Pausing new positions

Check `qb.can_open()` immediately before placing an order that opens or grows a
position. Pause state is saved by strategy name under
`$XDG_STATE_HOME/quantbot` or `~/.local/state/quantbot`. Set `QB_STATE_FILE` or
pass `state_file=` to choose a different persistent path. Give separate trading
processes separate strategy names and state files.

`qb.risk_triggered(reason)` records a risk pause.
`qb.connection("broker", ok, pause_on_failure=True)` can record a connection
pause. After the strategy verifies that the cause has been resolved, call
`qb.clear_pause("risk")` or `qb.clear_pause("connection")`. Remote resume clears
the manual pause only, after a registered resume handler returns successfully.

## Metrics and custom actions

```python
def refresh_cache(force: bool):
    return {"updated": rebuild_cache(force=force)}

qb.action(
    "refresh",
    refresh_cache,
    label="Refresh cache",
    fields={"force": {"type": "boolean", "label": "Force refresh"}},
    confirm=True,
)
qb.metric("equity", 10000.0, label="Equity", unit="USDT")
```

Report metrics from your trading loop. The web page charts the latest 240
observations per metric for the current server session. A custom action appears
in the strategy's web controls. Its handler runs on the strategy thread during
`qb.process()` or `qb.sleep()` and can return a message or JSON data. Field
types are `text`, `number`, `boolean`, and `select`. A select field declares
its choices in `options`; use `"required": False` in the field dictionary for
optional values.
