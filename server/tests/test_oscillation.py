"""The two-stroke cycle: two actions that each succeed and each undo the other.

An attendance roster offers "Mark all present" and "Clear all". Both work every
time they are clicked, so the existing repeat detector -- which only fires on an
action tried again WITHOUT effect, and which forgets any action that succeeded --
never sees a problem, while the page returns to exactly where it started on
every lap. The run looks like the agent is hallucinating; it is really cycling.
"""
from __future__ import annotations

from server.loop import is_oscillation


def _ran(*sigs: str):
    return [{"sig": s, "verb": "click", "nid": s, "eid": s, "name": s} for s in sigs]


class TestCycleDetection:
    def test_mark_all_then_clear_all_twice_is_a_cycle(self):
        assert is_oscillation(_ran("mark_all", "clear_all", "mark_all"), "clear_all")

    def test_a_single_pair_is_not_yet_a_cycle(self):
        """Clicking two different controls once each is ordinary work."""
        assert not is_oscillation(_ran("mark_all"), "clear_all")
        assert not is_oscillation(_ran("mark_all", "clear_all"), "mark_all")

    def test_genuine_progress_is_never_blocked(self):
        """Different controls in a row -- a real roster being ticked off."""
        assert not is_oscillation(_ran("row_1", "row_2", "row_3"), "row_4")

    def test_a_third_distinct_action_breaks_the_pattern(self):
        assert not is_oscillation(_ran("mark_all", "clear_all", "mark_all"), "submit")

    def test_the_same_action_four_times_is_left_to_the_repeat_detector(self):
        """Not an A/B cycle: identical repeats are the other guard's job."""
        assert not is_oscillation(_ran("mark_all", "mark_all", "mark_all"), "mark_all")

    def test_only_the_last_three_actions_matter(self):
        """An old cycle that the agent already escaped must not fire later."""
        assert not is_oscillation(
            _ran("mark_all", "clear_all", "mark_all", "clear_all", "row_1", "row_2"),
            "row_3",
        )
