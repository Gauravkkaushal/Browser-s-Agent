from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_operational_observations_capture_redacted_screenshots_by_default():
    source = (ROOT / "server" / "loop.py").read_text(encoding="utf-8")

    assert "async def observe(self, screenshot: bool = True)" in source
    assert "after = await self.observe(screenshot=True)" in source


def test_cockpit_receives_capture_errors_instead_of_staying_silently_blank():
    loop = (ROOT / "server" / "loop.py").read_text(encoding="utf-8")
    cockpit = (ROOT / "server" / "templates" / "cockpit.html").read_text(
        encoding="utf-8"
    )

    assert '"screenshot_error": obs.screenshot_error' in loop
    assert "else if (p.screenshot_error) showShotError(p.screenshot_error)" in cockpit
    assert "Redacted screenshot unavailable:" in cockpit


def test_cockpit_restores_the_last_redacted_screenshot_on_reconnect():
    cockpit = (ROOT / "server" / "templates" / "cockpit.html").read_text(
        encoding="utf-8"
    )

    assert "if (snap.last_screenshot) showShot(snap.last_screenshot)" in cockpit
