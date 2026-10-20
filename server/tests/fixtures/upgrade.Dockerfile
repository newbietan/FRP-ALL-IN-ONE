# Disposable integration fixture, not a production FRP image.
FROM python:3.11-alpine
ARG VERSION
ENV APP_VERSION=${VERSION}
LABEL io.frp-all-in-one.version="v${VERSION}" \
      io.frp-all-in-one.role="server" \
      io.frp-all-in-one.upgrade-protocol="1"
WORKDIR /app
COPY server/services/container_upgrade.py /usr/local/lib/frp/container_upgrade.py
COPY server/tests/fixtures/upgrade_service.py /app/service.py
CMD ["python3", "/app/service.py"]
