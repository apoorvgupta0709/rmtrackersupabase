"""A small PostgREST client, service-role.

Deliberately not a Postgres connection. This project would not hand out a working
connection string — the direct host refuses connections and every shared pooler answers
"tenant not found" — while the same database serves REST normally, so REST is what the
refresh uses. It turns out to be the better dependency anyway: a GitHub Actions runner
needs no database port open and no IPv4 add-on, and a measured 2,888 rows/s puts a whole
build at about eleven seconds.

Service-role bypasses RLS, so this must never run anywhere a browser can reach it.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path


class SupabaseRestError(RuntimeError):
    pass


def load_env(path: Path | str = ".env.local") -> dict[str, str]:
    """Read a dotenv file without adding a dependency for it."""
    values: dict[str, str] = {}
    path = Path(path)
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


class SupabaseRest:
    def __init__(self, url: str | None = None, service_key: str | None = None,
                 env_file: Path | str = ".env.local"):
        env = {**load_env(env_file), **os.environ}
        self.url = (url or env.get("NEXT_PUBLIC_SUPABASE_URL") or "").rstrip("/")
        self.key = service_key or env.get("SUPABASE_SERVICE_ROLE_KEY") or ""
        if not self.url or not self.key:
            raise SupabaseRestError(
                "Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — put them "
                "in .env.local (see .env.local.example) or the environment."
            )

    def _request(self, method: str, path: str, body=None, prefer: str | None = None,
                 retries: int = 3):
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            f"{self.url}/rest/v1/{path}", method=method, data=data, headers=headers
        )
        last: Exception | None = None
        for attempt in range(retries):
            try:
                with urllib.request.urlopen(request, timeout=120) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else []
            except urllib.error.HTTPError as error:
                detail = error.read().decode(errors="replace")[:500]
                # 4xx is a bad request and will fail identically on a retry; only a
                # server-side or transport problem is worth trying again.
                if error.code < 500:
                    raise SupabaseRestError(
                        f"{method} {path} -> HTTP {error.code}: {detail}"
                    ) from error
                last = SupabaseRestError(f"{method} {path} -> HTTP {error.code}: {detail}")
            except urllib.error.URLError as error:
                last = SupabaseRestError(f"{method} {path} -> {error.reason}")
            time.sleep(2 ** attempt)
        raise last  # type: ignore[misc]

    def select(self, table: str, query: str = "select=*"):
        return self._request("GET", f"{table}?{query}")

    def insert(self, table: str, rows, *, chunk: int = 2000, returning: bool = False,
               prefer: str | None = None, on_conflict: str | None = None):
        """Insert in chunks, because one request holding a whole dump times out.

        2,000 is what the throughput probe used; zmat's 65,178 rows go in 33 requests.

        `on_conflict` with `prefer="resolution=ignore-duplicates,..."` is how the sales
        ledger absorbs a dump: a line it already holds is left exactly as it was, so a
        re-sent day adds nothing and a backfill adds only what was missing. Note the two
        must be given together — PostgREST treats a resolution without a conflict target
        as an ordinary insert and raises on the first duplicate key.
        """
        if isinstance(rows, dict):
            rows = [rows]
        if prefer is None:
            prefer = "return=representation" if returning else "return=minimal"
        path = table if on_conflict is None else f"{table}?on_conflict={on_conflict}"
        out = []
        for start in range(0, len(rows), chunk):
            result = self._request("POST", path, rows[start:start + chunk], prefer)
            if returning:
                out.extend(result)
        return out

    def update(self, table: str, query: str, patch: dict, *, returning: bool = False):
        prefer = "return=representation" if returning else "return=minimal"
        return self._request("PATCH", f"{table}?{query}", patch, prefer)

    def delete(self, table: str, query: str):
        return self._request("DELETE", f"{table}?{query}")

    def rpc(self, function: str, args: dict | None = None):
        return self._request("POST", f"rpc/{function}", args or {})
