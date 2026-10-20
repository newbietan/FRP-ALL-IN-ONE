"""The ASGI application and its background tasks use asyncio, not Trio."""
import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"
