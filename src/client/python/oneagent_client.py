"""OneAgent Python Client SDK.

Uses only stdlib (urllib.request) — no external dependencies required.
Compatible with Python 3.8+.
"""

from __future__ import annotations

import json
import urllib.request
import urllib.error
import urllib.parse
from typing import Any, Dict, List, Optional


class OneAgentError(Exception):
    """Structured error from the OneAgent API."""

    def __init__(self, message: str, status_code: int, body: Any = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class OneAgentClient:
    """Client for the OneAgent REST API.

    Args:
        base_url: Base URL of the OneAgent server (e.g. "http://127.0.0.1:3000").
        api_key: Optional API key for authentication.
    """

    def __init__(self, base_url: str, api_key: Optional[str] = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._headers: Dict[str, str] = {"Content-Type": "application/json"}
        if api_key:
            self._headers["Authorization"] = f"Bearer {api_key}"

    # ─── Sites ───────────────────────────────────────────────────

    def list_sites(self) -> List[Dict[str, Any]]:
        """List all known sites."""
        return self._get("/api/sites")

    def get_site(self, site_id: str) -> Dict[str, Any]:
        """Get a site manifest by ID."""
        return self._get(f"/api/sites/{urllib.parse.quote(site_id, safe='')}")

    # ─── Skills ──────────────────────────────────────────────────

    def list_skills(
        self, site_id: Optional[str] = None, status: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """List skills, optionally filtered by site and status."""
        if site_id is None:
            sites = self.list_sites()
            all_skills: List[Dict[str, Any]] = []
            for site in sites:
                all_skills.extend(self.list_skills(site["id"], status))
            return all_skills

        qs = ""
        if status:
            qs = f"?status={urllib.parse.quote(status, safe='')}"
        return self._get(
            f"/api/sites/{urllib.parse.quote(site_id, safe='')}/skills{qs}"
        )

    # ─── Execute ─────────────────────────────────────────────────

    def execute_skill(
        self,
        site_id: str,
        name: str,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute a skill."""
        return self._post(
            f"/api/sites/{urllib.parse.quote(site_id, safe='')}/skills/{urllib.parse.quote(name, safe='')}",
            {"params": params or {}},
        )

    # ─── Dry Run ─────────────────────────────────────────────────

    def dry_run(
        self,
        site_id: str,
        name: str,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Preview a request without executing it."""
        return self._post(
            f"/api/sites/{urllib.parse.quote(site_id, safe='')}/skills/{urllib.parse.quote(name, safe='')}/dry-run",
            {"params": params or {}},
        )

    # ─── Validate ────────────────────────────────────────────────

    def validate(
        self,
        site_id: str,
        name: str,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Validate a skill."""
        return self._post(
            f"/api/sites/{urllib.parse.quote(site_id, safe='')}/skills/{urllib.parse.quote(name, safe='')}/validate",
            {"params": params or {}},
        )

    # ─── Explore ─────────────────────────────────────────────────

    def explore(self, url: str) -> Dict[str, Any]:
        """Start a browser exploration session."""
        return self._post("/api/explore", {"url": url})

    # ─── Record ──────────────────────────────────────────────────

    def record(
        self, name: str, inputs: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        """Start recording an action frame."""
        body: Dict[str, Any] = {"name": name}
        if inputs:
            body["inputs"] = inputs
        return self._post("/api/record", body)

    # ─── Stop ────────────────────────────────────────────────────

    def stop(self) -> Dict[str, Any]:
        """Stop recording and generate skills."""
        return self._post("/api/stop", {})

    # ─── Health ──────────────────────────────────────────────────

    def get_health(self) -> Dict[str, Any]:
        """Get server health status."""
        return self._get("/api/health")

    # ─── OpenAPI Spec ────────────────────────────────────────────

    def get_openapi_spec(self) -> Dict[str, Any]:
        """Get the OpenAPI specification."""
        return self._get("/api/openapi.json")

    # ─── HTTP Helpers ────────────────────────────────────────────

    def _get(self, path: str) -> Any:
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, method="GET", headers=self._headers)
        return self._do_request(req)

    def _post(self, path: str, body: Any) -> Any:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, method="POST", headers=self._headers
        )
        return self._do_request(req)

    def _do_request(self, req: urllib.request.Request) -> Any:
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read().decode("utf-8")
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    return raw
        except urllib.error.HTTPError as exc:
            raw_body = exc.read().decode("utf-8") if exc.fp else ""
            try:
                parsed = json.loads(raw_body)
            except (json.JSONDecodeError, ValueError):
                parsed = raw_body
            message = (
                parsed.get("error", f"HTTP {exc.code}")
                if isinstance(parsed, dict)
                else f"HTTP {exc.code}"
            )
            raise OneAgentError(message, exc.code, parsed) from exc
        except urllib.error.URLError as exc:
            raise OneAgentError(str(exc.reason), 0) from exc
