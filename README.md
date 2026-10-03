# JSON-LD Price Watch

**Free, zero-dependency price monitoring for product pages — no API key, no browser.**

JSON-LD Price Watch is a single-file Node.js CLI that fetches the product pages you care about, reads the `schema.org` **Product** / **Offer** structured data that sites already publish as JSON-LD, snapshots each price locally, and reports only what actually changed — drops and rises — over time. Because it reads published structured data instead of rendering pages, it is fast, cheap to run on a schedule, and works on any GitHub Actions runner with nothing to install.

## How it works

1. **Fetch** — each URL in `targets.json` is requested with a browser-like `User-Agent` using Node's built-in `fetch`. If the site rejects the request (some sites block Node's TLS fingerprint), the tool automatically falls back to `curl`.
2. **Parse** — every `<script type="application/ld+json">` block is extracted and parsed, tolerating technically-invalid JSON by stripping control characters first. `@graph` arrays and nested objects are walked.
3. **Normalize** — `Product` and `Offer` nodes are reduced to a stable record: `name`, `url`, `price`, `priceCurrency`, `availability`.
4. **Snapshot** — records are persisted to `state.json`, keyed per URL and product.
5. **Diff** — the new snapshot is compared with the previous one. Only real changes are written to `changes.md` and `changes.json`. The first run creates a baseline and reports `baseline created`; later runs report `no changes` or a specific drop/rise.

Exit code is `0` on success (including an unchanged run) and non-zero only on a hard failure, such as no target producing a usable price.

## Run locally

Requires Node.js 18 or newer. No `npm install` — there are no dependencies.

```bash
node scraper.mjs
```

On the first run:

```
Baseline created: Example Product — 19.99 USD
Run complete: baseline created.
```

On a later run with an unchanged price:

```
No changes: Example Product — 19.99 USD
Run complete: no changes detected.
```

Generated files:

| File | Purpose |
| --- | --- |
| `state.json` | Last-seen price per URL and product |
| `changes.json` | Machine-readable list of changes since the previous run |
| `changes.md` | Human-readable changelog of price drops and rises |

## Use it in your repository

1. Fork or copy this repository, then edit `targets.json` with the product URLs you want to watch:
   ```json
   [ { "url": "https://example.com/product/123" } ]
   ```
2. Commit your target list.
3. The included GitHub Actions workflow (`.github/workflows/monitor.yml`) runs automatically:
   - every day at **06:20 UTC** (`cron: '20 6 * * *'`),
   - on every `push` that touches `scraper.mjs`, `targets.json`, or the workflow file,
   - and on demand via **workflow_dispatch**.
4. The workflow runs the tool and commits the updated snapshots with the bot identity `lead-kit[bot]`, only when files actually changed, using the message `price watch update YYYY-MM-DD`.
5. Read `changes.md` in the repository, or pull `changes.json` into your own dashboard, to see price history.

To follow more products, just add URLs to `targets.json` — the snapshots are keyed per URL and product.

## Monetization

JSON-LD Price Watch is free and MIT-licensed for self-hosting. A hosted **Pro tier** — scheduled monitoring across many products with alerts and history export — is available through a Stripe Payment Link: [https://buy.stripe.com/jsonld-price-watch-pro](https://buy.stripe.com/jsonld-price-watch-pro).

## Project links

- Repository: https://github.com/nursatechstudio/jsonld-price-watch

## License

MIT — see [LICENSE](LICENSE).

**Built by nursatechstudio**
