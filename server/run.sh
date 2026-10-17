#!/bin/bash
PORT="${PORT:-8080}"
exec python -m uvicorn main:app --host 0.0.0.0 --port "$PORT"
