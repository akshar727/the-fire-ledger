# spaceapps-primary

**One Fire Record**: NASA FIRMS MODIS and VIIRS active-fire detections harmonized into one record (mainland Portugal, 2001-2025). NASA Space Apps Challenge 2026.

## Run it

Python precompute (from the repo root):

```bash
python3 build.py    # downloads FIRMS country archives into data/raw/, writes fire_grid_daily.csv
python3 model.py    # fits the model, writes site/public/data/portugal/annual.json (plus web/data.js, annual_summary.csv)
```

Website (Node.js LTS, from the repo root):

```bash
cd site && npm install && npm run dev     # http://localhost:3000
cd site && npm run build                  # type check + production build
```

CSV download endpoints (read-only, served from `site/public/data/`):

```
/api/hotspots?region=portugal&from=2017-08-01&to=2017-08-30[&bbox=-9,38,-8,39]
/api/series?region=portugal&res=annual
```

The site only reads files under `site/public/data/`; it never runs the model. Hosting: Vercel, project Root Directory `site`.

## Use of AI

Code, page text and documentation in this repository were written with help from Claude (Anthropic).

## References

Data
- NASA FIRMS active fire data, MODIS Collection 6.1 (Terra, Aqua) and VIIRS 375 m (Suomi NPP) country archives. Input data for everything. https://firms.modaps.eosdis.nasa.gov/country/ . NASA open data, no restrictions. Citation guidance: https://www.earthdata.nasa.gov/data/tools/firms . Acknowledgment (shown on every page): "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (https://earthdata.nasa.gov/lance) and NASA's Earth Science Data and Information System (ESDIS)."

Python libraries (precompute)
- numpy: arrays and bootstrap sampling. https://numpy.org . BSD-3-Clause
- pandas (1.5 or later, for `to_csv(lineterminator=...)`): reading, filtering and aggregating the CSVs. https://pandas.pydata.org . BSD-3-Clause
- statsmodels: Poisson GLM fit. https://www.statsmodels.org . BSD-3-Clause
- patsy: model design matrices. https://github.com/pydata/patsy . BSD-2-Clause
- Python standard library (`urllib.request`, `urllib.error`, `os`, `time`, `json`): downloads with timeout, retry and atomic rename; JSON export. https://docs.python.org/3/library/ . PSF License 2.0

Website (`site/`, versions pinned in `site/package-lock.json`)
- Next.js 16: web framework. https://nextjs.org . MIT
- React 19, React DOM: UI library. https://react.dev . MIT
- TypeScript: type checking. https://www.typescriptlang.org . Apache-2.0
- Tailwind CSS 4 (with @tailwindcss/turbopack): styling. https://tailwindcss.com . MIT
- shadcn/ui (`shadcn` CLI and copied component source in `site/components/ui/`): toggle group, tooltip, badge, separator, button. https://ui.shadcn.com . MIT
- cn: class-name merging used by shadcn/ui. https://github.com/shadcn-ui/cn . MIT
- Radix UI (`radix-ui`): accessible primitives under the shadcn/ui components. https://www.radix-ui.com . MIT
- class-variance-authority: component variants. https://cva.style . Apache-2.0
- tw-animate-css: animation utilities used by shadcn/ui. https://github.com/Wombosvideo/tw-animate-css . MIT
- Phosphor Icons (`@phosphor-icons/react`): icons. https://phosphoricons.com . MIT
- Geist and Geist Mono typefaces (via `next/font/google`): page typography. https://vercel.com/font . SIL Open Font License 1.1
- ESLint, eslint-config-next, babel-plugin-react-compiler: linting and build tooling. https://eslint.org , https://react.dev/learn/react-compiler . MIT

Code
- The record chart in `site/components/RecordChart.tsx` is ported from this project's own proof-of-concept page (`web/index.html`, commit `051327a`).
- Project scaffold from `create-next-app` (MIT). https://nextjs.org/docs/app/api-reference/cli/create-next-app

AI
- Claude (Anthropic): code, text and documentation assistance. https://www.anthropic.com/claude
