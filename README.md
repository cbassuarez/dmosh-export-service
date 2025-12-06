# dmosh-export-service

Backend export service that accepts export jobs, renders a short placeholder video with ffmpeg, and exposes a simple HTTP API for job management.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables (for local development create a `.env` file):
   - `EXPORT_AUTH_TOKEN` (required)
   - `CORS_ORIGIN` (required)
   - `PORT` (optional, defaults to `4000`)

3. Start the server:
   ```bash
   npm start
   ```

## API

- `GET /health` – returns `{ ok: true }` and does not require auth.
- `POST /exports` – enqueue a job. Requires header `X-Export-Token: <EXPORT_AUTH_TOKEN>` and body with `project`, `settings`, and optional `clientVersion`.
- `GET /exports/:id` – fetch job status.
- `GET /exports/:id/download` – download the rendered file when the job is complete.

All non-health routes require the `X-Export-Token` header.
