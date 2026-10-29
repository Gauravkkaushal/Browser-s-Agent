"""Characterization tests for server endpoints, security fixtures, and protocols."""
from __future__ import annotations

import re
from fastapi.testclient import TestClient

from server.main import app


client = TestClient(app)


def test_health_endpoint_contract():
    r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "model_chain" in data
    assert isinstance(data["model_chain"], list)
    assert "sessions" in data
    assert "guards" in data
    assert data["guards"]["max_steps"] == 60


def test_privacy_endpoint_served():
    r = client.get("/privacy")
    assert r.status_code == 200
    assert "NetraShield Privacy Policy" in r.text


def test_all_demo_fixtures_served():
    fixtures = [
        ("/fixtures/payment", "Payment"),
        ("/fixtures/pii", "Customer"),
        ("/fixtures/quakes", "Earthquakes"),
        ("/fixtures/job-application-demo", "TechNova"),
        ("/fixtures/prompt-injection-demo", "ByteBasket"),
    ]
    for endpoint, expected_content in fixtures:
        r = client.get(endpoint)
        assert r.status_code == 200, f"Failed for {endpoint}"
        assert expected_content.lower() in r.text.lower(), f"Expected {expected_content} in {endpoint}"


def test_cors_headers_are_present():
    r = client.options("/health", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "GET"})
    assert r.status_code == 200
    assert "access-control-allow-origin" in r.headers
