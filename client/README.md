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
