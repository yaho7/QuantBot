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
