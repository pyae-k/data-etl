# ETL Studio

Browser-based ETL tool for data cleaning and transformation, powered by DuckDB WASM. 100% private — no uploads.

## Features
- Load CSV, Parquet, and JSON files
- Visual pipeline editor with transform steps
- SQL queries and filters / aggregations
- Export results as CSV or Parquet
- Runs entirely in your browser (DuckDB WASM)

## Run Locally
This is a PWA and uses a Service Worker, so it requires an HTTP origin (not `file://`).

```bash
python3 -m http.server 8000
# Then open http://localhost:8000
```

## Deploy to GitHub Pages
1. Push this repository to GitHub.
2. Go to **Settings → Pages**.
3. Select **GitHub Actions** (or **Deploy from a branch**) as the build source.

## License
MIT — Free to use, modify, and distribute.
