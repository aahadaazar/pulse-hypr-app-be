# HYPR Pulse dashboard

React/Vite dashboard for the same health data shown in the mobile app. It uses
Firebase only for Google identity; all health-data reads go through the Hono
Worker API under ADR-001.

## Local development

Requires Node 20 or later.

From the repository root, start the Worker and dashboard together:

```bash
./scripts/dev.sh
```

Or start the dashboard on its own:

```bash
cd web
npm install
npm run dev
```

Vite serves on `http://localhost:5173`, which is already allow-listed by the
Worker. By default the dashboard reads the production API. To point it at a
local Worker, start Wrangler and use:

```bash
VITE_API_BASE_URL=http://localhost:8787/v1 npm run dev
```

The Firebase client configuration in `src/api.ts` is intentionally public: it
identifies this web application and contains no Firestore or service-account
credential.

## Delivery

The root workflow at `.github/workflows/deploy.yml` verifies both the Worker
and dashboard on pull requests. A push to `main` deploys the Worker production
environment and uploads `web/dist` to the `pulse-hypr` Cloudflare Pages project,
served at `https://pulse-hypr.pages.dev`.

It needs these GitHub Actions secrets in this root repository:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` (Workers Edit and Cloudflare Pages Edit)
