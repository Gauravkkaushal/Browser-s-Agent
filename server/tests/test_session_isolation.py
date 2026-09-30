import asyncio

import pytest
from fastapi.testclient import TestClient

from server.browser_bridge import bridge
from server.events import bus
from server.loop import registry
from server.runtime import InvalidSessionToken, RuntimeManager
from server.main import app
from server.runtime import runtimes


TOKEN_A = "A" * 43
TOKEN_B = "B" * 43


def test_invalid_or_missing_tokens_are_rejected():
    manager = RuntimeManager()
    for value in ("", "short", "contains spaces" * 4):
        with pytest.raises(InvalidSessionToken):
            manager.get(value)


def test_tokens_create_distinct_runtime_state():
    manager = RuntimeManager()
    first = manager.get(TOKEN_A)
    second = manager.get(TOKEN_B)
    assert first is manager.get(TOKEN_A)
    assert first is not second
    assert first.bridge is not second.bridge
    assert first.bus is not second.bus
    assert first.registry is not second.registry


def test_private_http_endpoints_require_a_bearer_token():
    response = TestClient(app).get("/tasks")
    assert response.status_code == 401


def test_http_task_lists_are_scoped_to_the_authenticated_installation():
    client = TestClient(app)
    runtime_a = runtimes.get(TOKEN_A)
    runtime_b = runtimes.get(TOKEN_B)
    with runtime_a.activate():
        runtime_a.registry.create("private task belonging to A")

    tasks_a = client.get("/tasks", headers={"Authorization": f"Bearer {TOKEN_A}"})
    tasks_b = client.get("/tasks", headers={"Authorization": f"Bearer {TOKEN_B}"})
    assert tasks_a.status_code == 200
    assert tasks_b.status_code == 200
    assert len(tasks_a.json()["tasks"]) == 1
    assert tasks_b.json()["tasks"] == []


def test_concurrent_contexts_route_all_proxies_to_their_owner():
    async def run():
      manager = RuntimeManager()
      first = manager.get(TOKEN_A)
      second = manager.get(TOKEN_B)

      async def inspect(runtime):
          with runtime.activate():
              await asyncio.sleep(0)
              return bridge.status(), bus.replay(), registry.list()

      (first_bridge, _, _), (second_bridge, _, _) = await asyncio.gather(
          inspect(first), inspect(second)
      )
      assert first_bridge == first.bridge.status()
      assert second_bridge == second.bridge.status()
      assert first_bridge is not second_bridge
    asyncio.run(run())


def test_events_do_not_cross_session_subscribers():
    async def run():
      manager = RuntimeManager()
      first = manager.get(TOKEN_A)
      second = manager.get(TOKEN_B)
      first_queue = first.bus.subscribe()
      second_queue = second.bus.subscribe()

      with first.activate():
          await bus.emit("ONLY_FIRST", {"owner": "first"})

      assert (await asyncio.wait_for(first_queue.get(), 0.2))["type"] == "ONLY_FIRST"
      with pytest.raises(asyncio.TimeoutError):
          await asyncio.wait_for(second_queue.get(), 0.02)
    asyncio.run(run())
