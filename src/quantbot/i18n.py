"""Language selection shared by the CLI, web console, and Telegram."""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
from importlib import resources
from typing import Any

DEFAULT_LANGUAGE = "zh"
LANGUAGES = ("zh", "en")
_language = ContextVar("quantbot_language", default=DEFAULT_LANGUAGE)


def normalize_language(value: object) -> str:
    return str(value) if value in LANGUAGES else DEFAULT_LANGUAGE


def language() -> str:
    return _language.get()


def language_tag() -> str:
    return "en" if language() == "en" else "zh-CN"


@contextmanager
def use_language(value: object) -> Iterator[None]:
    token = _language.set(normalize_language(value))
    try:
        yield
    finally:
        _language.reset(token)


@lru_cache(maxsize=1)
def english_messages() -> dict[str, str]:
    resource = resources.files("quantbot") / "locales" / "en.json"
    return json.loads(resource.read_text("utf-8"))


def tr(message: str, *args: Any, **kwargs: Any) -> str:
    translated = english_messages().get(message, message) if language() == "en" else message
    return translated.format(*args, **kwargs) if args or kwargs else translated
