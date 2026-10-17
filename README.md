## Deploy To Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/nitinyadav798906/get)

# Secure Device Test Server Pro

A hardened Express and Socket.IO service for authorized connectivity testing. It deliberately excludes surveillance and private-data collection features.

## Features

- Shared-token authentication for Socket.IO and protected HTTP endpoints
- Constant-time token comparison
- HTTP security headers using Helmet
- Request identifiers and no-store cache policy
- Basic HTTP and per-client socket event rate limits
- Per-IP connection caps
- Configurable browser origin allowlist
- Health, readiness, ping, metrics, and connected-client endpoints
- Payload size limits and safe JSON error responses
- Structured connection logs
- Graceful shutdown handling
- Automated tests and Render Blueprint configuration

## Requirements

Node.js 20 or newer and npm.

## Run locally

Linux/macOS:

```bash
export DEVICE_TEST_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
npm install
npm test
npm start
```

Windows PowerShell:

```powershell
$env:DEVICE_TEST_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm install
npm test
npm start
```

Check `http://localhost:8080/health`.

## Endpoints

- `GET /` — service and version status
- `GET /ping` — connectivity response
- `GET /health` — health check for hosting platforms
- `GET /ready` — readiness check
- `GET /metrics` — protected runtime metrics
- `GET /devices` — protected list of connected test clients

For `/metrics` and `/devices`, send the shared token in the `x-access-token` header.

## Deploy on Render

1. Push this project to a GitHub repository.
2. In Render, choose **New → Blueprint** and connect that repository.
3. Render reads `render.yaml`, creates the web service, and generates `DEVICE_TEST_TOKEN`.
4. Wait for the deployment to finish.
5. Visit `https://YOUR-SERVICE.onrender.com/health`.

If a browser-based Socket.IO client is hosted elsewhere, add its exact origin to `ALLOWED_ORIGINS` in Render's environment settings. Separate multiple origins with commas. Never expose the shared token in public frontend code.

## Security notes

- The HTTP rate limiter is in-memory and is intended for modest deployments, not as a replacement for a proxy or distributed rate limiter.
- The token is a shared secret. Use a separate authentication design for multiple untrusted users.
- Do not commit `.env` or production secrets.
- This application is a connectivity test service; it does not collect contacts, messages, location, clipboard contents, files, camera or microphone data, or keystrokes.
