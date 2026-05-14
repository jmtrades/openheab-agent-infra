"""auto_register — one-call agent provisioning + on-disk credential persistence."""

from __future__ import annotations

import os
import json
import pathlib
from typing import Optional, Tuple

from .client import OpenHeab, Identity


DEFAULT_BASE = "https://openheab.com"
DEFAULT_CRED_PATH = os.environ.get(
    "OPENHEAB_CREDENTIALS",
    str(pathlib.Path.home() / ".openheab" / "credentials.json"),
)


def auto_register(base_url: Optional[str] = None,
                  name: Optional[str] = None,
                  cred_path: Optional[str] = None,
                  metadata: Optional[dict] = None) -> Tuple[OpenHeab, Identity]:
    """
    Returns (client, identity). Persists credentials to ~/.openheab/credentials.json
    on first call; reuses them on subsequent calls.
    """
    base = base_url or os.environ.get("OPENHEAB_BASE_URL", DEFAULT_BASE)
    cpath = pathlib.Path(cred_path or DEFAULT_CRED_PATH)

    env_key = os.environ.get("OPENHEAB_API_KEY")
    env_did = os.environ.get("OPENHEAB_DID")
    if env_key and env_did:
        client = OpenHeab(base_url=base, api_key=env_key)
        return client, Identity(did=env_did, public_key="", api_key=env_key)

    if cpath.exists():
        try:
            data = json.loads(cpath.read_text())
            client = OpenHeab(base_url=base, api_key=data["api_key"])
            return client, Identity(
                did=data["did"],
                public_key=data.get("public_key", ""),
                api_key=data["api_key"],
            )
        except (json.JSONDecodeError, KeyError):
            pass

    client = OpenHeab(base_url=base)
    meta = metadata or {}
    if name:
        meta["name"] = name
    identity = client.identity.create(**meta)
    client.use_api_key(identity.api_key)

    cpath.parent.mkdir(parents=True, exist_ok=True)
    cpath.write_text(json.dumps({
        "did":         identity.did,
        "public_key":  identity.public_key,
        "private_key": identity.private_key,
        "api_key":     identity.api_key,
        "base_url":    base,
    }, indent=2))
    try:
        os.chmod(cpath, 0o600)
    except OSError:
        pass

    return client, identity
