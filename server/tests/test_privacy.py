from fastapi.testclient import TestClient

from server.main import app


def test_privacy_policy_is_public_and_contains_required_disclosures():
    response = TestClient(app).get("/privacy")
    assert response.status_code == 200
    assert "NetraShield Privacy Policy" in response.text
    assert "Gaurav Kaushal" in response.text
    assert "gaurav545th@gmail.com" in response.text
    assert "does not sell user data" in response.text
    assert "Chrome Web Store User Data Policy" in response.text
    assert "HTTPS and WSS" in response.text
