"""Independent strategy bearer tokens and administrator sessions."""

import hashlib
import hmac
import os
import secrets
import stat
from dataclasses import dataclass
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from .db import Database, encode, record
from .errors import Problem

TOKEN_PREFIX = "qb_"  # noqa: S105 - Public prefix, not a credential.
CREDENTIAL_RECORD_PREFIX = "credential.secret:"


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
    def __init__(self, db: Database, clock, key_path: Path | None):
        self.db = db
        self.clock = clock
        self.key_path = key_path

    def cipher(self, *, create=False):
        if self.key_path is None:
            raise Problem(503, "Persistent credentials are unavailable in this runtime")
        try:
            fd = os.open(self.key_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            stored = self.db.one(
                "SELECT 1 FROM settings WHERE name GLOB ? LIMIT 1",
                (CREDENTIAL_RECORD_PREFIX + "*",),
            )
            if not create or stored:
                raise Problem(503, "The access key encryption file is unavailable") from None
            key = Fernet.generate_key()
            try:
                fd = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as key_file:
                    key_file.write(key)
                    key_file.flush()
                    os.fsync(key_file.fileno())
            except OSError:
                raise Problem(503, "The access key encryption file cannot be created") from None
            return Fernet(key)
        except OSError:
            raise Problem(503, "The access key encryption file cannot be opened") from None
        with os.fdopen(fd, "rb") as key_file:
            mode = os.fstat(key_file.fileno()).st_mode
            if not stat.S_ISREG(mode) or stat.S_IMODE(mode) & 0o077:
                raise Problem(503, "The access key encryption file must be private")
            key = key_file.read(45)
        if len(key) != 44:
            raise Problem(503, "The access key encryption file is invalid")
        try:
            return Fernet(key)
        except ValueError:
            raise Problem(503, "The access key encryption file is invalid") from None

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
        encrypted = self.cipher(create=True).encrypt(secret.encode()).decode()
        self.db.execute(
            "INSERT INTO strategy_tokens VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
            (token_id, strategy_id, digest(secret), encode(options.scopes), now, expiry),
        )
        self.db.execute(
            "INSERT INTO settings VALUES (?, ?)", (CREDENTIAL_RECORD_PREFIX + token_id, encrypted)
        )
        return {"token": secret, **self.token_metadata(strategy_id, token_id)}

    def reveal(self, strategy_id, token_id):
        row = self.db.one(
            """SELECT digest FROM strategy_tokens WHERE strategy_id=? AND id=?
               AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)""",
            (strategy_id, token_id, self.clock()),
        )
        if row is None:
            raise Problem(404, "Active access key not found")
        stored = self.db.one(
            "SELECT value FROM settings WHERE name=?", (CREDENTIAL_RECORD_PREFIX + token_id,)
        )
        if stored is None:
            raise Problem(
                409, "This access key was issued before reveal was available; regenerate it"
            )
        try:
            secret = self.cipher().decrypt(stored["value"].encode()).decode()
        except (InvalidToken, UnicodeError):
            raise Problem(503, "The access key cannot be decrypted") from None
        if not hmac.compare_digest(digest(secret), row["digest"]):
            raise Problem(503, "The stored access key does not match this credential")
        return secret

    def forget(self, token_id):
        self.db.execute("DELETE FROM settings WHERE name=?", (CREDENTIAL_RECORD_PREFIX + token_id,))

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
