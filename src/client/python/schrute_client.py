"""Schrute Python Client SDK.

Uses only stdlib (urllib.request) — no external dependencies required.
Compatible with Python 3.8+.
"""

from __future__ import annotations

import json
import urllib.request
import urllib.error
import urllib.parse
from typing import Any, Dict, List, Optional


class SchruteError(Exception):
    """Structured error from the Schrute API."""

    def __init__(self, message: str, status_code: int, body: Any = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class SchruteClient:
    """Client for the Schrute REST API.

    Args:
        base_url: Base URL of the Schrute server (e.g. "http://127.0.0.1:3000").
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
        """Start a browser exploration session.

        Returns either a ready session payload or a browser handoff payload when
        a Cloudflare challenge requires recovery in a real Chrome session.
        """
        return self._post("/api/explore", {"url": url})

    def recover_explore(self, resume_token: str, wait_ms: Optional[int] = None) -> Dict[str, Any]:
        """Recover an explore session that requires real-Chrome handoff."""
        body: Dict[str, Any] = {"resumeToken": resume_token}
        if wait_ms is not None:
            body["waitMs"] = wait_ms
        return self._post("/api/recover-explore", body)

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
        """Stop recording and return a background pipeline job handle."""
        return self._post("/api/stop", {})

    def get_pipeline_status(self, job_id: str) -> Dict[str, Any]:
        """Get the status of a background recording pipeline job."""
        return self._get(f"/api/pipeline/{urllib.parse.quote(job_id, safe='')}")

    # ─── Health ──────────────────────────────────────────────────

    def get_health(self) -> Dict[str, Any]:
        """Get server health status."""
        return self._get("/api/health")

    # ─── OpenAPI Spec ────────────────────────────────────────────

    def get_openapi_spec(self) -> Dict[str, Any]:
        """Get the OpenAPI specification."""
        return self._get("/api/openapi.json")

    # ─── Search ──────────────────────────────────────────────────

    def search_skills(
        self,
        query: Optional[str] = None,
        site_id: Optional[str] = None,
        limit: Optional[int] = None,
        include_inactive: bool = False,
    ) -> Dict[str, Any]:
        """Search skills by query."""
        body: Dict[str, Any] = {}
        if query:
            body["query"] = query
        if site_id:
            body["siteId"] = site_id
        if limit:
            body["limit"] = limit
        if include_inactive:
            body["includeInactive"] = include_inactive
        resp = self._post("/api/v1/skills/search", body)
        if isinstance(resp, dict) and "data" in resp:
            return resp["data"]
        return resp

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
            raise SchruteError(message, exc.code, parsed) from exc
        except urllib.error.URLError as exc:
            raise SchruteError(str(exc.reason), 0) from exc
