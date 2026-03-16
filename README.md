# OpenDownloader

Download Google Drive view-only videos as a single MP4.
Paste a share link → pick quality → download. No extensions, no screen recording.

---

## How it works

1. **Fetch** — OpenDownloader opens the Drive link in a real Chrome session and intercepts the video/audio stream URLs.
2. **Select** — Choose the quality you want (1080p, 720p, 480p, …).
3. **Download** — Both streams are downloaded using your saved Google session, merged into one file, and delivered to your browser as a single MP4.

---

## Requirements

| Tool | Version |
|------|---------|
| Node.js | >= 20 |
| Google Chrome | latest stable |
| ffmpeg | any recent |

> **Docker users:** Chrome, ffmpeg, and Xvfb are all installed inside the image — no manual setup needed.

---

## Quick start (local)

```bash
# 1. Clone and install
git clone <repo-url>
cd opendownloader
npm install

# 2. Configure environment
cp .env.example .env
# For local dev only, you can run with NODE_ENV=development and no login (AUTH_BYPASS defaults to true)
# For production, set AUTH_BYPASS=false and configure JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD_HASH

# 3. Sign in to Google (one-time, saves session locally)
npm run setup:auth

# 4. Start
npm start
# Open http://localhost:3000
```

## Local production-like test checklist

Run this checklist before web deployment:

```bash
# 1. Install dependencies
npm install

# 2. Start in watch mode for development
npm run dev

# Note: in development, auth bypass is enabled by default.
# The app opens directly without login/JWT cookies.

# 3. In a second terminal, verify server is reachable
curl http://localhost:3000

# 4. Run one full flow for each workflow in UI
# - Video Downloader
# - Audio Converter (MP3/M4A)
# - Thumbnail Downloader (PNG/JPG/WEBP)
```

Open-source note:

- Add your repository URL in the top header Contribute button inside `public/index.html`.
- Keep CONTRIBUTING.md in your repo root so contributors can onboard quickly.

## GitHub publish safety checklist

Before pushing to GitHub:

- Ensure `.env` is not committed (only `.env.example` should be tracked).
- Ensure `.browser-data/` is not committed.
- Ensure `node_modules/` is not committed.
- Rotate JWT/password secrets if they were ever shared accidentally.
- Run `npm audit --omit=dev` and confirm there are no high/critical issues.

### Generate credentials

```bash
# JWT secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# bcrypt password hash (replace 'yourpassword')
node -e "import('bcryptjs').then(b => b.default.hash('yourpassword', 12).then(console.log))"
```

---

## Docker deployment

### 1. Build and start

```bash
cp .env.example .env
# Edit .env with your real values

docker compose up -d --build
```

### 2. Set up Google auth (one-time)

The Google session must be captured on a machine **with a display** (your local machine or a VPS with VNC/X11).

**Option A — set up locally, copy to server:**

```bash
# On your local machine (Chrome must be installed)
npm install
npm run setup:auth
# Sign in to Google when Chrome opens, then close the browser window

# Copy the saved session to your server
rsync -av .browser-data/ user@yourserver:/path/to/opendownloader/.browser-data/
```

**Option B — X11 forwarding on a VPS:**

```bash
ssh -X user@yourserver
docker compose run --rm \
  -e DISPLAY=$DISPLAY \
  -v /tmp/.X11-unix:/tmp/.X11-unix \
  opendownloader node scripts/setup-auth.js
```

### 3. Verify

```bash
curl http://localhost:3000/api/auth/status
# 401 Unauthorized — expected, login required
```

---

## Nginx reverse proxy (recommended)

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    # Your SSL config here ...

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Required for large file streaming
        proxy_buffering    off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

Set `ALLOWED_ORIGINS=https://yourdomain.com` in your `.env`.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Random string, minimum 32 characters |
| `ADMIN_USERNAME` | Yes | Login username |
| `ADMIN_PASSWORD_HASH` | Yes | bcrypt hash of your password |
| `ALLOWED_ORIGINS` | Yes | Comma-separated list of allowed origins |
| `PORT` | No | Server port (default `3000`) |
| `AUTH_BYPASS` | No | Set `true` to bypass login/JWT for local development only (default true in development, false in production) |
| `JWT_ACCESS_EXPIRY` | No | Access token lifetime (default `15m`) |
| `JWT_REFRESH_EXPIRY` | No | Refresh token lifetime (default `7d`) |
| `RATE_LIMIT_MAX` | No | API requests per 15 min window (default `50`) |
| `DOWNLOAD_RATE_MAX` | No | Download starts per 15 min window (default `5`) |

---

## Security notes

- In production (`AUTH_BYPASS=false`), every route requires a valid login session with signed httpOnly cookies (JWT).
- In local development (`NODE_ENV=development`), auth bypass is enabled by default for faster testing.
- Rate limiting is enforced on all API and download endpoints.
- `.browser-data/` contains your Google session — keep it private and never commit it.
- Downloaded streams are written to the system temp directory and deleted immediately after each download completes.

---

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).

Please still respect copyright law and each platform's terms of service, including [Google Drive's Terms of Service](https://policies.google.com/terms).
