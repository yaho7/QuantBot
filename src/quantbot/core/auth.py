"""Independent strategy bearer tokens and administrator sessions."""

import hashlib
import hmac
import secrets
from dataclasses import dataclass

from .db import Database, encode, record
from .errors import Problem

TOKEN_PREFIX = "qb_"  # noqa: S105 - Public prefix, not a credential.


def digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def password_hash(password: str) -> str:
    salt = secrets.token_hex(16)
    value = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1)
    return f"scrypt$16384$8$1${salt}${value.hex()}"


def password_matches(password: str, stored: str) -> bool:
    kind, n, r, p, salt, expected = stored.split("$")
    if kind != "scrypt":
        return False
    value = hashlib.scrypt(
        password.encode(),
        salt=bytes.fromhex(salt),
        n=int(n),
        r=int(r),
        p=int(p),
        dklen=len(bytes.fromhex(expected)),
    )
    return hmac.compare_digest(value.hex(), expected)


@dataclass(frozen=True)
class Credential:
    id: str
    strategy_id: str
    scopes: frozenset[str]


class Auth:
    def __init__(self, db: Database, clock):
        self.db = db
        self.clock = clock

    def has_administrator(self) -> bool:
        return self.db.one("SELECT 1 FROM settings WHERE name='administrator'") is not None

    def create_administrator(self, username: str, hashed_password: str) -> bool:
        inserted = self.db.execute(
            "INSERT OR IGNORE INTO settings VALUES ('administrator', ?)",
            (encode({"username": username, "password_hash": hashed_password}),),
        )
        return inserted.rowcount == 1

    def issue(self, strategy_id, options):
        now = self.clock()
        expiry = options.expires_at.timestamp() if options.expires_at else None
        if expiry is not None and expiry <= now:
            raise Problem(422, "Token expiry must be in the future")
        token_id = secrets.token_hex(12)
        secret = TOKEN_PREFIX + secrets.token_urlsafe(32)
        self.db.execute(
            "INSERT INTO strategy_tokens VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
            (token_id, strategy_id, digest(secret), encode(options.scopes), now, expiry),
        )
        return {"token": secret, **self.token_metadata(strategy_id, token_id)}

    def token_metadata(self, strategy_id, token_id):
        row = self.db.one(
            "SELECT * FROM strategy_tokens WHERE strategy_id=? AND id=?", (strategy_id, token_id)
        )
        if row is None:
            raise Problem(404, "Token not found")
        return self.public_token(row)

    @staticmethod
    def public_token(row):
        return record(
            row,
            documents=("scopes",),
            omit=("digest",),
            times=("created_at", "expires_at", "revoked_at", "last_used_at"),
        )

    def authenticate(self, secret: str | None, scope: str) -> Credential:
        if not secret or len(secret) > 128:
            raise Problem(401, "Invalid strategy credential")
        now = self.clock()
        row = self.db.one(
            """SELECT t.* FROM strategy_tokens t JOIN strategies s ON s.id=t.strategy_id
               WHERE t.digest=? AND t.revoked_at IS NULL AND s.archived_at IS NULL
               AND (t.expires_at IS NULL OR t.expires_at>?)""",
            (digest(secret), now),
        )
        if row is None:
            raise Problem(401, "Invalid strategy credential")
        scopes = frozenset(self.public_token(row)["scopes"])
        if scope not in scopes:
            raise Problem(403, "Token lacks the required scope")
        self.db.execute(
            """UPDATE strategy_tokens SET last_used_at=? WHERE id=?
               AND (last_used_at IS NULL OR last_used_at<?)""",
            (now, row["id"], now - 30),
        )
        return Credential(row["id"], row["strategy_id"], scopes)

    def session(self, actor: str) -> str:
        secret = secrets.token_urlsafe(32)
        self.db.execute(
            "INSERT INTO admin_sessions VALUES (?, ?, ?)",
            (digest(secret), actor, self.clock() + 12 * 3600),
        )
        return secret

    def administrator(self, secret: str | None) -> str:
        if not secret or len(secret) != 43:
            raise Problem(401, "Administrator sign-in required")
        row = self.db.one(
            "SELECT actor FROM admin_sessions WHERE digest=? AND expires_at>?",
            (digest(secret), self.clock()),
        )
        if row is None:
            raise Problem(401, "Administrator sign-in required")
        return row["actor"]

    def login_link(self, actor: str) -> str:
        secret = secrets.token_urlsafe(32)
        self.db.execute(
            "INSERT INTO login_links VALUES (?, ?, ?)", (digest(secret), actor, self.clock() + 300)
        )
        return secret

    def consume_link(self, secret: str):
        with self.db.transaction():
            row = self.db.one(
                "DELETE FROM login_links WHERE digest=? AND expires_at>? RETURNING actor",
                (digest(secret), self.clock()),
            )
            if row is None:
                raise Problem(401, "Invalid or expired login link")
            return self.session(row["actor"])
