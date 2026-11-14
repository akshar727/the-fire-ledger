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

The site only reads files under `site/public/data/`; it never runs the model. Hosting: Vercel, project Root Directory `site`.

## Use of AI

Code, page text and documentation in this repository were written with help from Claude (Anthropic).

## References

Data
- NASA Fire Information for Resource Management System (FIRMS), yearly country archive CSVs — source of every fire detection in this project — https://firms.modaps.eosdis.nasa.gov/download/ — NASA data, openly shared without restriction (EOSDIS data use guidance); provided "as is" (https://www.earthdata.nasa.gov/data/projects/lance/disclaimer). Acknowledgment (verbatim from https://www.earthdata.nasa.gov/data/tools/firms, checked 2026-11-14): "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (https://earthdata.nasa.gov/lance) and NASA's Earth Science Data and Information System (ESDIS)."
- MODIS active fire locations, MCD14ML (Terra + Aqua, 1 km), standard processing via the FIRMS country archive — MODIS detections 2000–2025 — https://doi.org/10.5067/FIRMS/MODIS/MCD14ML — Giglio, L. (2000). MODIS Thermal Anomalies/Fire Products [Dataset]. NASA Land Atmosphere Near real-time Capability for EOS Fire Information for Resource Management System. https://doi.org/10.5067/FIRMS/MODIS/MCD14ML (citation from the DOI's DataCite record, checked 2026-11-14). The archive files' `version` field reads 6.2 (2000–2017), 6.03 (2018–2022) and 61.03 (2023–2025).
- VIIRS Suomi NPP 375 m active fire locations, VNP14IMGML Collection 2, standard processing via the FIRMS country archive — VIIRS detections 2012–2025 — https://doi.org/10.5067/VIIRS/VNP14IMG.002 — No DOI is registered for the monthly location product VNP14IMGML (doi.org and DataCite checked 2026-11-14), so we cite the Level-2 swath product of the same algorithm and collection: Giglio, L. (2024). VIIRS/NPP Active Fires 6-Min L2 Swath 375m V002 [Dataset]. NASA Land Processes Distributed Active Archive Center. https://doi.org/10.5067/VIIRS/VNP14IMG.002. Archive files' `version` field: 2.
- MODIS active fire algorithm — method behind the MODIS detections — https://doi.org/10.1016/j.rse.2016.02.054 — Giglio, L., Schroeder, W., & Justice, C. O. (2016). The collection 6 MODIS active fire detection algorithm and fire products. Remote Sensing of Environment, 178, 31–41.
- VIIRS 375 m active fire algorithm — method behind the VIIRS detections — https://doi.org/10.1016/j.rse.2013.12.008 — Schroeder, W., Oliva, P., Giglio, L., & Csiszar, I. A. (2014). The New VIIRS 375 m active fire detection data product: Algorithm description and initial assessment. Remote Sensing of Environment, 143, 85–96.

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
