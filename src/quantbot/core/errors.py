class Problem(Exception):
    def __init__(self, status: int, detail: str, *, retry_after: int | None = None):
        super().__init__(detail)
        self.status = status
        self.retry_after = retry_after
