# spaceapps-primary

**One Fire Record**: NASA FIRMS MODIS and VIIRS active-fire detections harmonized into one record (mainland Portugal, Ghana and NW India, 2001-2025; one model fit per region). NASA Space Apps Challenge 2026.

## Run it

Python precompute (from the repo root). Needs Python 3.12 or newer (tested with 3.14): check with `python3 --version` (Windows: `python --version`) first, and install a newer one from python.org or Homebrew if it's older, or `pip install` fails with "No matching distribution found for scipy==1.18.1"; library versions are pinned in `requirements.txt` (numpy 2.4.4, pandas 3.0.2, statsmodels 0.14.6, patsy 1.0.2, scipy 1.18.1), so reruns reproduce the committed outputs. Use `python` on Windows, `python3` on macOS.

1. Create and activate a virtual environment.
   - Windows (PowerShell): `python -m venv .venv` then `.venv\Scripts\Activate.ps1` (if blocked: `Set-ExecutionPolicy -Scope Process Bypass`)
   - macOS: `python3 -m venv .venv` then `source .venv/bin/activate`
2. `pip install -r requirements.txt`

```bash
python build.py             # all regions in regions.json; the first run downloads ~1 GB for Ghana + NW India into data/raw/
python build.py portugal    # one region; Portugal's raw files are committed, so this needs no network
python model.py             # every region in regions.json (~16 min, peak ~2.4 GB): site/public/data/<region>/annual.json + series.json
python model.py portugal    # one region (~3 min); the inputs (data/grid/) are committed, so no build.py run is needed first
python model.py portugal --nboot 20   # quick dev run with fewer bootstrap draws; never commit its output
```

### Data outputs (written by `build.py`)

- `regions.json` (hand-edited input): one entry per region: `id`, `name`, FIRMS `country` file name, `bbox` [west, south, east, north] (west/south edges inclusive, east/north exclusive; edge cells can stick out slightly when an edge isn't a multiple of 0.25°), `fire_type`. After editing a region's entry, rebuild that region (`python build.py <id>`) so its grid and the index match. The `punjab` box also covers part of Pakistani Punjab, but only India's FIRMS file is used, so that side is empty.
- `data/grid/fire_grid_daily_<region>.csv`: detections per 0.25° cell (south-west corner) × UTC day × day/night, per satellite (Terra, Aqua, VIIRS S-NPP), with mean fire radiative power. Sparse: missing rows mean zero detections.
- `data/grid/manifest.json`: per region, `archive_through` (latest date in the downloaded FIRMS files) and per sensor `first_date` / `last_date` / `detections`. `last_date` is the **last day a fire was detected**, not the end of the data.
- `site/public/data/index.json`: the region list the website reads; `data_through` = `archive_through`; `point_years` / `point_rows` list the years and total rows of the point files.
- `site/public/data/<region>/points/<year>.csv`: the individual detections (same filter as the grid), header `date,time_utc,lat,lon,satellite,confidence,frp_mw,daynight`, sorted by date and time; `satellite` is `Terra`, `Aqua` or `SNPP`, `time_utc` is HHMM, `confidence` is as in FIRMS (MODIS 0–100, VIIRS `l`/`n`/`h`). Only years with at least one detection get a file.
- Raw downloads go to `data/raw/` (only Portugal's are committed).

Website (Node.js LTS, from the repo root):

```bash
cd site && npm install && npm run dev     # http://localhost:3000
cd site && npm run build                  # type check + production build
cd site && npm test                       # unit tests for the series.json parser and calendar grid (Node >= 23.6)
```

CSV download endpoints (read-only, served from `site/public/data/`):

```
/api/hotspots?region=portugal&from=2017-08-01&to=2017-08-30[&bbox=-9,38,-8,39]
/api/series?region=portugal&res=annual
```

The site only reads files under `site/public/data/`; it never runs the model. Hosting: Vercel, project Root Directory `site`.

## Check before you open a PR

There is no CI: run these yourself before every pull request to `main`, from the repo root, in the virtual environment from "Run it" (Node.js 24 or newer for `npm test`):

```bash
pip install -r requirements.txt                  # pinned versions (Python 3.12+)
python -m unittest discover -s tests -v
python scripts/check_outputs.py --snapshot       # before the pipeline: remembers your working tree
python build.py portugal                         # no network: Portugal's raw files are committed
python model.py
python scripts/check_outputs.py
```

```bash
cd site && npm ci && npm run lint && npm test && npm run build
```

Local runs compare against your working tree as it was before the pipeline ran (the `--snapshot` step), so uncommitted code edits are fine; without a snapshot the baseline is `HEAD`. `check_outputs.py` fails if rerunning the pipeline changed any committed output (beyond float rounding in JSON) or left a new untracked file: regenerate and commit the outputs together with your code change. Any untracked file that `.gitignore` doesn't cover (e.g. a `.DS_Store`) is reported as new, so delete it or ignore it.

## Use of AI

Code, page text and documentation in this repository were written with help from Claude (Anthropic).

## References

Data
- Region boxes in `regions.json` (Portugal, Ghana, NW India) were chosen by the team; no external source.
- NASA Fire Information for Resource Management System (FIRMS), yearly country archive CSVs — source of every fire detection in this project — https://firms.modaps.eosdis.nasa.gov/download/ — NASA data, openly shared without restriction (EOSDIS data use guidance); provided "as is" (https://www.earthdata.nasa.gov/data/projects/lance/disclaimer). Acknowledgment (verbatim from https://www.earthdata.nasa.gov/data/tools/firms, checked 2026-11-14): "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (https://earthdata.nasa.gov/lance) and NASA's Earth Science Data and Information System (ESDIS)."
- MODIS active fire locations, MCD14ML (Terra + Aqua, 1 km), standard processing via the FIRMS country archive — MODIS detections 2000–2025 — https://doi.org/10.5067/FIRMS/MODIS/MCD14ML — Giglio, L. (2000). MODIS Thermal Anomalies/Fire Products [Dataset]. NASA Land Atmosphere Near real-time Capability for EOS Fire Information for Resource Management System. https://doi.org/10.5067/FIRMS/MODIS/MCD14ML (citation from the DOI's DataCite record, checked 2026-11-14). The archive files' `version` field reads 6.2 (2000–2017), 6.03 (2018–2022) and 61.03 (2023–2025).
- VIIRS Suomi NPP 375 m active fire locations, VNP14IMGML Collection 2, standard processing via the FIRMS country archive — VIIRS detections 2012–2025 — https://doi.org/10.5067/VIIRS/VNP14IMG.002 — No DOI is registered for the monthly location product VNP14IMGML (doi.org and DataCite checked 2026-11-14), so we cite the Level-2 swath product of the same algorithm and collection: Giglio, L. (2024). VIIRS/NPP Active Fires 6-Min L2 Swath 375m V002 [Dataset]. NASA Land Processes Distributed Active Archive Center. https://doi.org/10.5067/VIIRS/VNP14IMG.002. Archive files' `version` field: 2.
- MODIS active fire algorithm — method behind the MODIS detections — https://doi.org/10.1016/j.rse.2016.02.054 — Giglio, L., Schroeder, W., & Justice, C. O. (2016). The collection 6 MODIS active fire detection algorithm and fire products. Remote Sensing of Environment, 178, 31–41.
- VIIRS 375 m active fire algorithm — method behind the VIIRS detections — https://doi.org/10.1016/j.rse.2013.12.008 — Schroeder, W., Oliva, P., Giglio, L., & Csiszar, I. A. (2014). The New VIIRS 375 m active fire detection data product: Algorithm description and initial assessment. Remote Sensing of Environment, 143, 85–96.

Python libraries (precompute; exact versions in `requirements.txt`)
- numpy 2.4.4: arrays and bootstrap sampling. https://numpy.org . BSD-3-Clause
- pandas 3.0.2: reading, filtering and aggregating the CSVs. https://pandas.pydata.org . BSD-3-Clause
- statsmodels 0.14.6: Poisson GLM fit. https://www.statsmodels.org . BSD-3-Clause
- patsy 1.0.2: model design matrices. https://github.com/pydata/patsy . BSD-2-Clause
- scipy 1.18.1: numerical routines used by statsmodels (installed with it, pinned for reproducibility). https://scipy.org . BSD-3-Clause
- Python standard library (`urllib.request`, `urllib.error`, `os`, `re`, `time`, `json`, `argparse`, `unittest`, `pathlib`, `datetime`): downloads with timeout, retry and atomic rename; JSON export; region config checks and command line; the `tests/test_site_data.py` data checks. https://docs.python.org/3/library/ . PSF License 2.0

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
- `site/fixtures/series.portugal.sample.json`: test fixture built from this repo's Portugal grid (then `fire_grid_daily.csv`, now `data/grid/fire_grid_daily_portugal.csv`; NASA FIRMS data above); its harmonized values are placeholders, not model output.
- The burn calendar (`/calendar`) reads this project's own model export, `site/public/data/<region>/series.json` (harmonized monthly counts from `model.py`, month medians, middle half and unusual-month flags from `calendar_stats.py`; NASA FIRMS data above). The fire-season line per region is reworded from `site/public/data/index.json` (team-written region notes). No new library, data source or asset.
- The record chart in `site/components/RecordChart.tsx` is ported from this project's own proof-of-concept page (`web/index.html`, commit `051327a`).
- Region switcher, date range and downloads (`site/components/RegionSwitcher.tsx`, `DateRange.tsx`, `DownloadCsv.tsx`, `site/lib/selection.ts`): the region list and dates come from this project's own `site/public/data/index.json`; "Download CSV" and "Download analytics" call this project's own `/api/hotspots` and `/api/series` route handlers; the whole-year links point to this project's own `site/public/data/<region>/points/<year>.csv` files (all NASA FIRMS data above, with the FIRMS acknowledgment shown next to the buttons). Uses the browser's built-in date and select inputs; no new library, data source or asset.
- Project scaffold from `create-next-app` (MIT). https://nextjs.org/docs/app/api-reference/cli/create-next-app


AI
- Claude (Anthropic): code, text and documentation assistance. https://www.anthropic.com/claude
