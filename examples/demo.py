"""A pretend strategy that shows every QuantBot feature without a broker.

Prices are a random walk. Run it with QB_URL and QB_TOKEN set, then press the
buttons in Telegram. Replace the Paper class with your own broker code.
"""

from __future__ import annotations

import logging
import random
import uuid
from datetime import datetime, timedelta, timezone

from quantbot_client import QuantBot

PREFIX = "demo-"  # tag our orders, so flatten only touches what is ours


class Paper:
    def __init__(self) -> None:
        self.cash = 10_000.0
        self.price = {"QQQ": 500.0, "SPY": 580.0}
        self.shares: dict[str, int] = {}
        self.orders: dict[str, str] = {}

    def tick(self) -> None:
        for symbol in self.price:
            self.price[symbol] *= 1 + random.gauss(0, 0.002)  # noqa: S311 - not crypto

    def buy(self, symbol: str, qty: int) -> str:
        self.cash -= qty * self.price[symbol]
        self.shares[symbol] = self.shares.get(symbol, 0) + qty
        return f"{symbol} BUY {qty} @ {self.price[symbol]:.2f}"

    def sell(self, symbol: str, qty: int) -> str:
        qty = min(qty, self.shares.get(symbol, 0))
        self.cash += qty * self.price[symbol]
        self.shares[symbol] = self.shares.get(symbol, 0) - qty
        if not self.shares[symbol]:
            del self.shares[symbol]
        return f"{symbol} SELL {qty} @ {self.price[symbol]:.2f}"

    def equity(self) -> float:
        return self.cash + sum(q * self.price[s] for s, q in self.shares.items())


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    broker = Paper()
    params = {"symbol": "QQQ", "qty": 5, "buy_below": 498.0, "sell_above": 503.0}
    stop_id = PREFIX + uuid.uuid4().hex[:8]
    broker.orders[stop_id] = "SELL QQQ 5 @ 480.00 止损"
    qb = QuantBot()

    def status() -> dict:
        lines = [f"净值 {broker.equity():,.2f}  现金 {broker.cash:,.2f}"]
        lines += [f"{s} {broker.price[s]:.2f}" for s in broker.price]
        return {"text": "\n".join(lines), "paused": qb.paused}

    def positions() -> str:
        rows = [f"{s} {q} 股 @ {broker.price[s]:.2f}" for s, q in broker.shares.items()]
        return "\n".join(rows) or "没有持仓。"

    def cancel(order_id: str) -> str:
        if broker.orders.pop(order_id, None) is None:
            raise LookupError("这个挂单已经不在了")
        return "已撤单"

    def flatten() -> str:
        done = [broker.sell(s, q) for s, q in list(broker.shares.items())]
        for line in done:
            qb.fill(line)
        return "；".join(done) or "没有持仓，不用平。"

    def set_param(name: str, value: object) -> str:
        if name not in params:
            raise KeyError(name)
        params[name] = value
        return ""

    def manual_order(side: str, symbol: str, qty: float) -> str:
        if symbol not in broker.price:
            raise ValueError(f"不认识 {symbol}")
        line = broker.buy(symbol, int(qty)) if side == "buy" else broker.sell(symbol, int(qty))
        qb.fill(line)
        return line

    qb.on("status", status).on("positions", positions)
    qb.on("orders", lambda: [{"id": k, "text": v} for k, v in broker.orders.items()])
    qb.on("cancel", cancel).on("flatten", flatten)
    qb.on("params", lambda: dict(params)).on("set_param", set_param)
    qb.on("manual_order", manual_order)

    with qb:
        qb.info("示例策略已启动")
        qb.connection("模拟行情", True)
        qb.expiry("模拟授权", datetime.now(timezone.utc) + timedelta(days=7))
        while not qb.stopping:
            broker.tick()
            symbol = str(params["symbol"])
            price = broker.price[symbol]
            if price < float(params["buy_below"]) and qb.can_open():  # type: ignore[arg-type]
                qb.fill(broker.buy(symbol, int(params["qty"])))  # type: ignore[call-overload]
            elif price > float(params["sell_above"]) and broker.shares.get(symbol):  # type: ignore[arg-type]
                qb.fill(broker.sell(symbol, broker.shares[symbol]))
            qb.status(status()["text"])
            qb.heartbeat()
            if not qb.sleep(5):
                break
    print("stopped")


if __name__ == "__main__":
    main()
