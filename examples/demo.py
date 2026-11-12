"""A paper strategy for trying the Web and Telegram controls with simulated funds."""

import random
import struct
import uuid
import zlib
from datetime import datetime, timedelta, timezone

from quantbot_client import CommandRejected, QuantBot


class Paper:
    def __init__(self) -> None:
        self.cash = 10_000.0
        self.price = {"QQQ": 500.0, "SPY": 580.0}
        self.shares = {"QQQ": 2.0}
        self.orders: dict[str, str] = {}
        self.history: list[float] = []
        self.new_order()

    def new_order(self) -> str:
        self.orders["paper-" + uuid.uuid4().hex[:8]] = "模拟 SELL QQQ 1 @ 480.00"
        return "已添加模拟挂单。"

    def equity(self) -> float:
        return self.cash + sum(qty * self.price[symbol] for symbol, qty in self.shares.items())

    def tick(self) -> None:
        for symbol in self.price:
            self.price[symbol] *= 1 + random.gauss(0, 0.002)  # noqa: S311 - paper prices
        self.history = [*self.history[-63:], self.equity()]

    def order(self, side: str, symbol: str, qty: float) -> str:
        price = self.price[symbol]
        held = self.shares.get(symbol, 0)
        if side == "buy":
            if qty * price > self.cash:
                raise CommandRejected("模拟账户余额不足。")
            self.cash -= qty * price
            self.shares[symbol] = held + qty
        else:
            if qty > held:
                raise CommandRejected("模拟持仓不足。")
            self.cash += qty * price
            if qty == held:
                del self.shares[symbol]
            else:
                self.shares[symbol] = held - qty
        return f"模拟 {symbol} {side.upper()} {qty:g} @ {price:.2f}"

    def chart(self) -> bytes:
        values = self.history or [self.equity()]
        low, high = min(values), max(values)
        heights = [8 + int(48 * (value - low) / max(1, high - low)) for value in values]
        width = 256
        height = 64
        background, bar = b"\x18\x22\x33", b"\x48\xd5\xab"
        rows = []
        for y in range(height, 0, -1):
            row = [bar * 3 + background if y <= level else background * 4 for level in heights]
            rows.append(b"\0" + b"".join(row) + background * (width - 4 * len(heights)))

        def chunk(kind: bytes, body: bytes) -> bytes:
            return (
                struct.pack(">I", len(body))
                + kind
                + body
                + struct.pack(">I", zlib.crc32(kind + body))
            )

        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows)))
            + chunk(b"IEND", b"")
        )


def main() -> None:
    paper = Paper()
    qb = QuantBot()
    params = {"order_limit": 10.0}

    def status() -> str:
        return f"模拟策略 · 净值 {paper.equity():,.2f} · 现金 {paper.cash:,.2f}"

    def positions() -> str:
        rows = [f"{s} {q:g} 股 @ {paper.price[s]:.2f}" for s, q in paper.shares.items()]
        return "\n".join(rows) or "没有模拟持仓。"

    def cancel(order_id: str) -> str:
        if paper.orders.pop(order_id, None) is None:
            raise CommandRejected("这个模拟挂单已不存在。")
        return "已撤销模拟挂单。"

    def flatten() -> str:
        done = [paper.order("sell", s, q) for s, q in list(paper.shares.items())]
        for line in done:
            qb.fill(line)
        return "；".join(done) or "没有模拟持仓。"

    def set_param(name: str, value: float) -> str:
        if name not in params or not 0 < value <= 100:
            raise CommandRejected("模拟下单上限须在 0 到 100 之间。")
        params[name] = value
        return ""

    def manual_order(side: str, symbol: str, qty: float) -> str:
        if side not in ("buy", "sell") or symbol not in paper.price:
            raise CommandRejected("模拟策略支持 QQQ 和 SPY。")
        if not 0 < qty <= params["order_limit"]:
            raise CommandRejected(f"模拟下单上限为 {params['order_limit']:g}。")
        if side == "buy" and not qb.can_open():
            raise CommandRejected("策略已暂停开仓。")
        line = paper.order(side, symbol, qty)
        qb.fill(line)
        return line

    qb.on("status", status).on("positions", positions).on("chart", paper.chart)
    qb.on("orders", lambda: [{"id": k, "text": v} for k, v in paper.orders.items()])
    qb.on("cancel", cancel).on("flatten", flatten)
    qb.on("params", lambda: dict(params)).on("set_param", set_param)
    qb.on("manual_order", manual_order)
    qb.action("paper_order", paper.new_order, label="添加模拟挂单", confirm=True)

    with qb:
        qb.info("快速入手已启动，可使用网页或 Telegram 操作模拟策略。")
        qb.connection("模拟行情", True)
        qb.expiry("模拟授权", datetime.now(timezone.utc) + timedelta(days=7))
        while not qb.stopping:
            paper.tick()
            qb.status(status())
            qb.metric("equity", paper.equity(), label="模拟净值")
            if not qb.sleep(3):
                break


if __name__ == "__main__":
    main()
