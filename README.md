# spaceapps-primary

**One Fire Record**: NASA FIRMS MODIS and VIIRS active-fire detections harmonized into one record (mainland Portugal, Ghana and NW India, 2001 to 2 November 2026; one model fit per region). NASA Space Apps Challenge 2026.

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

Recent data comes from the FIRMS area API, which needs a free key: MODIS and VIIRS Suomi NPP from 1 January 2026 to 2 November 2026 (the last Suomi NPP day), VIIRS NOAA-20 from 1 January 2026 (2018–2025 is in the country archive) and VIIRS NOAA-21 from 1 January 2024 (no archive), both up to yesterday. The answers are committed in `data/raw/recent/`, so `build.py` and `model.py` never need the key. Only to refresh them:

```powershell
$env:FIRMS_MAP_KEY = Read-Host "FIRMS key"   # key from https://firms.modaps.eosdis.nasa.gov/api/map_key/; this window only
python fetch_recent.py --sensors VIIRS_NOAA20,VIIRS_NOAA21   # extend NOAA-20/21 to yesterday; MODIS/S-NPP chunks stay as they are
python fetch_recent.py                        # everything (~280 requests per region); may swap NRT days for newer SP ones
```

Independent check against MODIS burned area (`referee.py`, method page "An independent check"). The extract is committed in `data/referee/burned_area.csv`, so normally only the second line is needed (after `model.py`, numpy/pandas only):

```bash
python referee.py extract <folder>   # once: reads MCD64CMQ .hdf files (needs `pip install pyhdf`, Python <= 3.14) -> data/referee/burned_area.csv
python referee.py                    # -> site/public/data/referee.json (detections per 1,000 km2 burned, before vs after 2012)
```

The `.hdf` files come from the University of Maryland SFTP server in the MCD64 user guide, section 4.1 (server, public login and folder `data/MODIS/C6/MCD64CMQ` are given there; https://lpdaac.usgs.gov/documents/1006/MCD64_User_Guide_V61.pdf). About 65 MB; not committed.

Fire weather (`weather.py`, DP-014): NASA POWER daily data (no key) at up to 9 points per region, each the fire-weighted centre of one ninth of the region's box, so no point sits over the sea. Answers are cached in `data/raw/power/<region>/` (gitignored, about 0.3 MB per point); `--refresh` fetches them again up to yesterday. Output: `site/public/data/<region>/weather.json` with monthly regional means, a fire-weather index (dry air from `T2M_MAX` and `RH2M` × wind `WS10M`, halved after 25 mm of rain in the last 30 days) and the month's worst 7-day spell of dry air (`vpd_peak7`), each as a percentile within its calendar month. It never feeds `model.py`.

```bash
python weather.py             # all regions (~1 min the first time; then reads the cache)
python weather.py --refresh   # fetch again to extend to yesterday
```

### Data outputs (written by `build.py`)

- `regions.json` (hand-edited input): one entry per region: `id`, `name`, FIRMS `country` file name, `bbox` [west, south, east, north] (west/south edges inclusive, east/north exclusive; edge cells can stick out slightly when an edge isn't a multiple of 0.25°), `fire_type`. After editing a region's entry, rebuild that region (`python build.py <id>`) so its grid and the index match. The `punjab` box also covers part of Pakistani Punjab, but only India's FIRMS file is used for 2000–2025, so that side is empty. 2026 comes from the area API (whole box), so `build.py` keeps a 2026 detection only if its 0.05° sub-cell (~5.5 km) had a detection in the 2000–2025 archive. With whole 0.25° cells, about 6% of 2026 detections fell on ground with no detection in 2000–2024 (the neighbour's side of border cells, plus untyped NRT static sources); the 0.05° filter drops at most ~0.3% of genuine detections.
- `data/grid/fire_grid_daily_<region>.csv`: detections per 0.25° cell (south-west corner) × UTC day × day/night, per satellite, with mean fire radiative power: `terra_n`, `aqua_n`, `viirs_n` (VIIRS Suomi NPP; the model's input), their `*_frp_mean`, then `n20_n`, `n21_n` (VIIRS NOAA-20 / NOAA-21) and their `*_frp_mean`. Sparse: missing rows mean zero detections. Rows after 2 November 2026 hold NOAA counts only. NOAA rows never change the Terra/Aqua/S-NPP values.
- `data/grid/manifest.json`: per region, `archive_through` (last day the model's sensors, MODIS and S-NPP, cover) and per sensor (`terra`, `aqua`, `viirs`, `n20`, `n21`) `first_date` / `last_date` / `detections` / `data_through`. `last_date` is the **last day a fire was detected**, not the end of the data; `data_through` is how far that sensor's data reach: the last date in its raw archive files (before filtering) or its `fetch_recent.py` `through` (`null` = no data). S-NPP is capped at its end of life, 2026-11-02.
- `site/public/data/index.json`: the region list the website reads; `data_through` = `archive_through`; per sensor `first_date` / `last_date` / `data_through`; `point_years` / `point_rows` list the years and total rows of the point files.
- `site/public/data/<region>/points/<year>.csv`: the individual detections (same filter as the grid), header `date,time_utc,lat,lon,satellite,confidence,frp_mw,daynight`, sorted by date and time; `satellite` is `Terra`, `Aqua`, `SNPP`, `NOAA20` or `NOAA21`, `time_utc` is HHMM, `confidence` is as in FIRMS (MODIS 0–100, VIIRS `l`/`n`/`h`). Only years with at least one detection get a file.
- Raw downloads go to `data/raw/` (only Portugal's are committed).
- `data/raw/recent/<region>/`: area-API answers in 5-day chunks (`<SOURCE>_<first>_<last>.csv`, committed) plus `coverage.json` (`sensors`: each sensor's `start` / `through`; top-level `through` = last day covered for both MODIS and S-NPP). Standard processing (SP) is used up to its last available day, near-real-time (NRT) after it; NRT rows have no `type` column, so they are kept unfiltered (all four sensors). The 0.05° border filter uses only MODIS and S-NPP archive detections, for every sensor.

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

Landing-page scene (`scripts/landing_scene/`, FE-019): the 180 frames in `site/public/scene/` that scroll behind the story on `/`. They are rendered with [Blender](https://www.blender.org) 5.3 from this repository's own files: NASA SRTM elevation of central Portugal (`scripts/landing_scene/srtm_tiles/`, four tiles, committed), the 2017 detections in `site/public/data/portugal/points/2017.csv`, and the harmonized monthly record in `site/public/data/portugal/series.json` (the closing calendar layout). `layout.py` (numpy only, covered by `tests/test_landing_scene.py`) decides where everything is on each frame; `scene.py` draws it. No models, textures or images are imported: the trees, smoke, sky and the two plain satellites are built by the script. Terrain heights are multiplied by 2.5.

```bash
# macOS path shown; on Windows use the full path to blender.exe. About 6 minutes for all 180 frames (Apple M2 Pro).
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/landing_scene/scene.py -- --all --quality 75
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/landing_scene/scene.py -- --frames 0,36,72 --scale 50 --out "$TMPDIR/scene-preview"   # a quick look, outside the repo
/Applications/Blender.app/Contents/MacOS/Blender --factory-startup -P scripts/landing_scene/scene.py   # open the scene (new, unsaved file) and scrub frames 0-179
```

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

The frames in `site/public/scene/` are not AI-generated images: they are Blender renders of the scene that `scripts/landing_scene/scene.py` builds from SRTM elevation and FIRMS detections. That script, like the rest of the code, was written with help from Claude.

## References

Data
- Region boxes in `regions.json` (Portugal, Ghana, NW India) were chosen by the team; no external source.
- NASA Fire Information for Resource Management System (FIRMS), yearly country archive CSVs — source of every fire detection in this project — https://firms.modaps.eosdis.nasa.gov/download/ — NASA data, openly shared without restriction (EOSDIS data use guidance); provided "as is" (https://www.earthdata.nasa.gov/data/projects/lance/disclaimer). Acknowledgment (verbatim from https://www.earthdata.nasa.gov/data/tools/firms, checked 2026-11-14): "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (https://earthdata.nasa.gov/lance) and NASA's Earth Science Data and Information System (ESDIS)."
- MODIS active fire locations, MCD14ML (Terra + Aqua, 1 km), standard processing via the FIRMS country archive — MODIS detections 2000–2025 — https://doi.org/10.5067/FIRMS/MODIS/MCD14ML — Giglio, L. (2000). MODIS Thermal Anomalies/Fire Products [Dataset]. NASA Land Atmosphere Near real-time Capability for EOS Fire Information for Resource Management System. https://doi.org/10.5067/FIRMS/MODIS/MCD14ML (citation from the DOI's DataCite record, checked 2026-11-14). The archive files' `version` field reads 6.2 (2000–2017), 6.03 (2018–2022) and 61.03 (2023–2025).
- VIIRS Suomi NPP 375 m active fire locations, VNP14IMGML Collection 2, standard processing via the FIRMS country archive — VIIRS detections 2012–2025 — https://doi.org/10.5067/VIIRS/VNP14IMG.002 — No DOI is registered for the monthly location product VNP14IMGML (doi.org and DataCite checked 2026-11-14), so we cite the Level-2 swath product of the same algorithm and collection: Giglio, L. (2024). VIIRS/NPP Active Fires 6-Min L2 Swath 375m V002 [Dataset]. NASA Land Processes Distributed Active Archive Center. https://doi.org/10.5067/VIIRS/VNP14IMG.002. Archive files' `version` field: 2.
- NASA FIRMS area API — MODIS and S-NPP detections 1 January to 2 November 2026, NOAA-20 from 1 January 2026 and NOAA-21 from 1 January 2024 to the day before the fetch, for each region's bbox, fetched by `fetch_recent.py` with a personal MAP_KEY (not stored); sources `MODIS_SP/NRT`, `VIIRS_SNPP_SP/NRT`, `VIIRS_NOAA20_SP/NRT`, `VIIRS_NOAA21_SP/NRT` (listed on the API page, checked 2026-11-15) — https://firms.modaps.eosdis.nasa.gov/api/area/ — same NASA data terms and FIRMS acknowledgment as above. 2026 standard-processing rows come from the same MCD14ML and VNP14IMGML products cited above, and the NOAA products below.
- VIIRS NOAA-20 375 m active fire locations, VJ114IMGML Collection 2, standard processing via the FIRMS country archive (folder `viirs-jpss1`, files from 1–2 April 2018; satellite code `N20`) — NOAA-20 detections 2018–2025, and the NOAA-20 SP rows from the area API — https://doi.org/10.5067/VIIRS/VJ114IMG.002 — as for S-NPP, we cite the Level-2 swath product of the same algorithm and collection: Giglio, L. (2024). VIIRS/JPSS1 Active Fires 6-Min L2 Swath 375m V002 [Dataset]. NASA Land Processes Distributed Active Archive Center. https://doi.org/10.5067/VIIRS/VJ114IMG.002 (DataCite record checked 2026-11-15). Archive files' `version` field: 2.
- VIIRS NOAA-21 375 m active fire locations, VJ214IMGML, standard processing via the area API only (FIRMS has no NOAA-21 country archive, checked 2026-11-15; satellite code `N21`) — https://doi.org/10.5067/VIIRS/VJ214IMG.002 — Giglio, L. (2026). VIIRS/JPSS2 Thermal Anomalies/Fire 6-Min L2 Swath 375m V002 [Dataset]. NASA Land Processes Distributed Active Archive Center (DataCite record checked 2026-11-15).
- VIIRS NOAA-20 near real-time active fire locations, VJ114IMGTDL_NRT version 2 — NOAA-20 NRT rows — https://doi.org/10.5067/FIRMS/VIIRS/VJ114IMGT_NRT.002 — NASA VIIRS Land Science Team. (2020). VIIRS NOAA-20 (JPSS-1) 375m, I-Band Active Fire Product NRT (Vector Data) [Data set]. NASA LANCE MODIS at the MODAPS (checked 2026-11-15).
- VIIRS NOAA-21 near real-time active fire locations, VJ214IMGTDL_NRT version 2 — NOAA-21 NRT rows — https://doi.org/10.5067/FIRMS/VIIRS/VJ214IMGT_NRT.002 — NASA VIIRS Land Science Team. (2026). VIIRS (NOAA-21) I Band 375m Active Fire Product NRT (Vector data) [Data set]. NASA LANCE MODIS at the MODAPS (checked 2026-11-15).
- FIRMS satellite codes (`N` = Suomi NPP, `N20` = NOAA-20, `N21` = NOAA-21) and NOAA-21's orbit ~50 minutes ahead of NOAA-20 — NASA Earthdata, "VIIRS I-Band 375 m Active Fire Data" — https://www.earthdata.nasa.gov/data/instruments/viirs/viirs-i-band-375-m-active-fire-data (checked 2026-11-15); used for the `SAT` / `POINT_SAT` mappings in `build.py`.
- MODIS near real-time active fire locations, MCD14DL version 6.1NRT ("MODIS/Aqua Terra Thermal Anomalies/Fire locations 1km FIRMS NRT (Vector data)") — MODIS detections 2026-09-01 to 2026-11-02 — https://doi.org/10.5067/FIRMS/MODIS/MCD14DL.NRT.0061 — NASA MODIS Science Data Support Team, NASA LANCE MODIS at the MODAPS (title taken from the catalog record; the citation text on that page names a VIIRS product by mistake, checked 2026-11-15).
- VIIRS Suomi NPP near real-time active fire locations, VNP14IMGTDL_NRT version 2 — VIIRS detections 2026-08-01 to 2026-11-02 — https://doi.org/10.5067/FIRMS/VIIRS/VNP14IMGT_NRT.002 — NASA VIIRS Land Science Team. (2020). VIIRS (S-NPP) I Band 375 m Active Fire Product NRT (Vector data) [Data set]. NASA LANCE MODIS at the MODAPS (checked 2026-11-15).
- NASA POWER (Prediction Of Worldwide Energy Resources) Daily API, point endpoint, community AG, parameters `T2M_MAX`, `RH2M`, `PRECTOTCORR`, `WS10M`, `GWETTOP` — daily weather 2000-12-01 to yesterday for the fire-weather index (`weather.py`) — https://power.larc.nasa.gov/docs/services/api/temporal/daily/ — "These data were obtained from the NASA Langley Research Center (LaRC) POWER Project funded through the NASA Earth Science/Applied Science Program." No key; NASA data, openly shared.
- MERRA-2 reanalysis (the source POWER serves for these parameters) — https://doi.org/10.1175/JCLI-D-16-0758.1 — Gelaro, R., et al. (2017). The Modern-Era Retrospective Analysis for Research and Applications, Version 2 (MERRA-2). Journal of Climate, 30(14), 5419–5454.
- Saturation vapour pressure (Tetens form, `0.6108 exp(17.27 T / (T + 237.3))` kPa) for the vapour-pressure deficit in `weather.py` — FAO Irrigation and Drainage Paper 56, equation 11 — https://www.fao.org/4/x0490e/x0490e00.htm — Allen, R. G., Pereira, L. S., Raes, D., & Smith, M. (1998).
- MODIS active fire algorithm — method behind the MODIS detections — https://doi.org/10.1016/j.rse.2016.02.054 — Giglio, L., Schroeder, W., & Justice, C. O. (2016). The collection 6 MODIS active fire detection algorithm and fire products. Remote Sensing of Environment, 178, 31–41.
- MODIS burned area, MCD64CMQ Collection 6 (0.25° monthly climate-modelling-grid summary of MCD64A1) — burned area per region-month 2000-11 to 2022-12 for the independent check (`referee.py`) — https://doi.org/10.5067/MODIS/MCD64A1.006 — Giglio, L., Justice, C., Boschetti, L., & Roy, D. (2015). MCD64A1 MODIS/Terra+Aqua Burned Area Monthly L3 Global 500m SIN Grid V006 [Dataset]. NASA Land Processes Distributed Active Archive Center. MCD64CMQ has no DOI of its own; files from the University of Maryland SFTP server (MCD64 user guide §4.1, https://lpdaac.usgs.gov/documents/1006/MCD64_User_Guide_V61.pdf, checked 2026-11-15). No restrictions on use.
- MODIS burned area algorithm — method behind MCD64 — https://doi.org/10.1016/j.rse.2018.08.005 — Giglio, L., Boschetti, L., Roy, D. P., Humber, M. L., & Justice, C. O. (2018). The Collection 6 MODIS burned area mapping algorithm and product. Remote Sensing of Environment, 217, 72–85.
- VIIRS 375 m active fire algorithm — method behind the VIIRS detections — https://doi.org/10.1016/j.rse.2013.12.008 — Schroeder, W., Oliva, P., Giglio, L., & Csiszar, I. A. (2014). The New VIIRS 375 m active fire detection data product: Algorithm description and initial assessment. Remote Sensing of Environment, 143, 85–96.
- NASA Shuttle Radar Topography Mission Global 3 arc second (SRTM GL3, about 90 m), tiles N39W009, N39W008, N40W009, N40W008 (39-41 N, 9-7 W), committed in `scripts/landing_scene/srtm_tiles/` — the terrain of the landing-page scene (`scripts/landing_scene/`) — https://doi.org/10.5067/MEASURES/SRTM/SRTMGL3.003 — NASA JPL (2013). NASA Shuttle Radar Topography Mission Global 3 arc second [Data set]. NASA Land Processes Distributed Active Archive Center (DataCite record checked 2026-11-15). NASA data, openly shared without restriction. Downloaded as GeoTIFF from OpenTopography's public bulk-download bucket (`https://opentopography.s3.sdsc.edu/raster/SRTM_GL3/SRTM_GL3_srtm/North/North_30_60/<tile>.tif`, no login, fetched 2026-11-15): NASA Shuttle Radar Topography Mission (SRTM) (2013). Shuttle Radar Topography Mission (SRTM) Global. Distributed by OpenTopography. https://doi.org/10.5069/G9445JDF (DataCite record checked 2026-11-15).
- Pedrógão Grande fire, 17 June 2017 (the fire the landing page and its scene follow): place and date only; every detection drawn is from the FIRMS files above (`site/public/data/portugal/points/2017.csv`). Torre, Serra da Estrela (1,993 m, 40.3217 N, 7.6130 W) is used by `tests/test_landing_scene.py` to check that the SRTM mosaic is placed correctly (general geographic fact).

Python libraries (precompute; exact versions in `requirements.txt`)
- numpy 2.4.4: arrays and bootstrap sampling. https://numpy.org . BSD-3-Clause
- pandas 3.0.2: reading, filtering and aggregating the CSVs. https://pandas.pydata.org . BSD-3-Clause
- statsmodels 0.14.6: Poisson GLM fit. https://www.statsmodels.org . BSD-3-Clause
- patsy 1.0.2: model design matrices. https://github.com/pydata/patsy . BSD-2-Clause
- pyhdf 0.11.7: reads the HDF4 burned-area files in `referee.py extract` only (one-off; not in `requirements.txt` because it has no build for Python 3.15). https://github.com/fhs/pyhdf . MIT
- scipy 1.18.1: numerical routines used by statsmodels, and `scipy.stats.theilslopes` / `kendalltau` for the trend block (`trend_stats.py`). https://scipy.org . BSD-3-Clause
- Python standard library (`urllib.request`, `urllib.error`, `os`, `re`, `time`, `json`, `argparse`, `unittest`, `pathlib`, `datetime`): downloads with timeout, retry and atomic rename; JSON export; region config checks and command line; the `tests/test_site_data.py` data checks. https://docs.python.org/3/library/ . PSF License 2.0
- Blender 5.3 (EEVEE renderer, compositor glare, WebP writer) with its bundled Python 3.13 and numpy 2.3: builds and renders the landing-page scene (`scripts/landing_scene/scene.py`); not needed to run the site or the model. https://www.blender.org . GPL-2.0-or-later (the program; the rendered frames are ours)
- Python standard library, also `struct`, `zlib`, `csv`, `math`, `sys`, `tempfile` (`scripts/landing_scene/srtm.py`, `layout.py`, `scene.py`, `tests/test_landing_scene.py`): decoding the SRTM GeoTIFF tiles (tiled, deflate) and reading the points file. Same link and license as above.
- `bpy` and `mathutils` (Blender's own Python modules, part of Blender 5.3 above): scene building and vector maths in `scene.py`. GPL-2.0-or-later

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
- Latitude/longitude box for the hotspot CSV (`site/components/BoxFilter.tsx`, box helpers in `site/lib/selection.ts`, `useBox` in `site/lib/use-selection.ts`): four typed edges, kept in the URL as `?bbox=w,s,e,n` and passed to this project's own `/api/hotspots` `bbox` filter; the region boxes it checks against come from this project's own `regions.json` via `site/public/data/index.json` (NASA FIRMS data above). Plain text inputs; no new library, data source or asset.
- Partial-year handling in the record chart (`site/lib/annual.ts`, `site/components/RecordChart.tsx`): reads the `partial` and `data_through` fields of this project's own `site/public/data/<region>/annual.json` (written by `model.py`; NASA FIRMS data above, including the 2026 area-API rows). The model years (VIIRS from 2012, hold-out from 2020) mirror `model.py`. No new library, data source or asset.
- Trend block in `annual.json` (`trend_stats.py`, called by `model.py`): Theil-Sen slope with a 90% interval and the Mann-Kendall trend test, on the naive stitched record and the harmonized record of this project's own model output (NASA FIRMS data above). Methods: Sen, P. K. (1968), "Estimates of the regression coefficient based on Kendall's tau", JASA 63(324), 1379–1389; Mann, H. B. (1945), "Nonparametric tests against trend", Econometrica 13(3), 245–259; implemented with scipy (above). No new library or data source.
- Landing-page scene (`scripts/landing_scene/srtm.py`, `layout.py`, `scene.py`, `tests/test_landing_scene.py`): written for this project. Terrain from the SRTM tiles above; squares from this project's own `site/public/data/portugal/points/2017.csv`, at the nominal pixel sizes (MODIS 1 km, VIIRS 375 m) already cited above; the calendar layout from this project's own `site/public/data/portugal/series.json`. The trees, smoke, sky, satellites and scan lines are simple shapes made by the script: no 3D model, texture, HDRI or NASA media is used. The slope limiter in the camera curve is the standard Fritsch-Carlson monotone cubic: Fritsch, F. N., & Carlson, R. E. (1980). Monotone piecewise cubic interpolation. SIAM Journal on Numerical Analysis, 17(2), 238-246. https://doi.org/10.1137/0717021
- Scroll scene on `/` (`site/lib/scene.ts`, `site/components/story/StoryScene.tsx`, `StorySceneGate.tsx`, "Scroll scene" in `site/app/globals.css`): written for this project; draws the frames in `site/public/scene/` on a `<canvas>` with browser APIs only (`fetch`, `createImageBitmap`, `requestAnimationFrame`, `ResizeObserver`, `matchMedia`), no added package.
- Project scaffold from `create-next-app` (MIT). https://nextjs.org/docs/app/api-reference/cli/create-next-app


Images
- `site/public/scene/f000.webp` to `f179.webp` (180 frames, 1600 x 900): rendered by this project with Blender from `scripts/landing_scene/scene.py` (SRTM elevation and FIRMS detections cited above). No third-party image, model or texture.

AI
- Claude (Anthropic): code, text and documentation assistance. https://www.anthropic.com/claude
