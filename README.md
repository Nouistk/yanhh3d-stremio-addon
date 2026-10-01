# YanHH3D Stremio Add-on

A Node.js/Express Stremio addon that reads the current YanHH3D website catalog and exposes it to Stremio as a series catalog.

## Endpoints

- /manifest.json
- /catalog/series/yanhh3d.json
- /meta/series/:id.json
- /stream/series/:id.json

## Run locally

```bash
npm install
npm start
```

Default port: 7000.

## Configuration

`YANHH3D_BASE_URL` defaults to `https://yanhh3d.ee`.

If YanHH3D changes its active domain, set the environment variable to the current domain.

## Deployment

The repository includes `render.yaml` for a Render web service.

After deployment, install:

`https://YOUR-DOMAIN/manifest.json`

## Notes

YanHH3D's page structure and player implementation can change. The addon therefore scrapes the live site at request time and uses short-lived caching.

Only use streams/content you are authorized to access.
