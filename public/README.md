Static assets served at the site root (favicon, etc.).

This directory is committed even while empty so the Dockerfile's `COPY … /app/public ./public`
has a target — Docker fails a `COPY` of a missing path.
