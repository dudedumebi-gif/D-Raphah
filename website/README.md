# Raphah.io website

The runnable React/Vite frontend lives in `artifacts/raphah-site/`. It includes
the source pages, responsive styling, consultation form, and generated API
client usage.

Run it from the repository root with:

```bash
pnpm --filter @workspace/raphah-site run dev
```

The shared consultation API lives in `artifacts/api-server/`, its contract is
in `lib/api-spec/openapi.yaml`, and the PostgreSQL schema is in
`lib/db/src/schema/`.

The `website/` directory remains the public website boundary in the
`D-Raphah` repository layout. The compiled static snapshot is retained here
under `website/assets/`; source-of-truth frontend code is under
`artifacts/raphah-site/`.