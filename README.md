# spaceapps-primary

**Fire Ledger**: NASA FIRMS MODIS and VIIRS active-fire detections harmonized into one ledger (mainland Portugal, Ghana and NW India, 2001 to 2 November 2026; one model fit per region). NASA Space Apps Challenge 2026.

## Features

- **Landing story (`/`)**: a scroll-driven story over a Blender-rendered scene of the 2017 central Portugal fires. It explains how the satellites see fire and why their counts need harmonizing, then ends on the burn calendar.
- **3D globe (`/globe`)**: spin a globe of every country with a fire record and colour it by one year or by the trend since 2001. Play through the years, or click a country to see its numbers.
- **Ledger (`/ledger`)**: the harmonized fire record for a region, with a region switcher, date range and plain-language trend summary. A method card says how the record was built and how far to trust it.
- **This fire season so far**: the latest season's running total of fire drawn over every past season, so you can see whether this year is running ahead or behind.
- **When each season burns**: the days on which each past season reached 10%, 50% and 90% of its fire, showing whether seasons start or peak earlier than they used to.
- **Burn calendar (`/calendar`)**: one square per month since 2001, all on one scale, so bad and quiet seasons stand out at a glance. Each region gets a line on fire weather (dry air, wind, rain) from NASA POWER. A month/week switcher shows the weekly counts as well. A "This month so far" section shows the running month against the same days of past years, with the NASA POWER fire-weather percentile.
- **Listen to the calendar**: plays the calendar as sound, one note per month, with higher notes meaning more fire. A short tour plays the raw and harmonized counts around the 2012 change of satellite, so you can hear the jump that harmonizing removes.
- **From space**: below the calendar, pick a month and its fire detections appear over NASA satellite imagery of that month's peak fire day.
- **Downloads**: every chart can be saved as a picture, and the data can be downloaded as CSV for any date range and map box. The same CSVs are served at `/api/hotspots` and `/api/series`.
- **Proof on unseen years**: the model is trained on 2012 to 2019 and scored on 2020 to 2025 against what VIIRS really counted. The scores are shown on the ledger and the method page. Ghana was 4.3% vs 6.8% for one ratio; in NW India the ratio wins (3.2% vs 7.3%) and the page publishes such results.
- **World scoreboard (`/method#scoreboard`)**: in every country, our model is tested against one simple constant ratio. Where the ratio did better, the site publishes the ratio. The model won in 92 of 176 countries. Seven, however, are too sparse to check.
- **Independent check (`/method#referee`)**: fire detections are compared with MODIS burned area before and after 2012 as a check that does not depend on our model. The 2012 jump in detections per km^2 burned is 2.2–4.6x stitched and 0.84–1.04x harmonized.
- **Satellite drift (`/method#drift`)**: shows how the Terra and Aqua overpass times have drifted, and why that changes the share of each day's fire that MODIS sees. Terra now passes about 1.5 hours earlier and Aqua about 1.5 hours later than in training, so recent MODIS isn't very usable and reliable.
- **Accessible charts**: charts can be read with the keyboard (arrow keys step through values), and each one has a text description for screen readers.
- **Was it the weather?**: the site shows high and low-fire months compared against top-quarter fire weather.

The Python pipeline behind these pages (download, harmonization model, fire weather, peak days, referee check, landing scene) is described step by step in "Run it" below.

## Run it

Python precompute (from the repo root). Needs Python 3.12 or newer (tested with 3.14): check with `python3 --version` (Windows: `python --version`) first, and install a newer one from python.org or Homebrew if it's older, or `pip install` fails with "No matching distribution found for scipy==1.18.1"; library versions are pinned in `requirements.txt` (numpy 2.4.4, pandas 3.0.2, statsmodels 0.14.6, patsy 1.0.2, scipy 1.18.1), so reruns reproduce the committed outputs. Use `python` on Windows, `python3` on macOS.

1. Create and activate a virtual environment.
   - Windows (PowerShell): `python -m venv .venv` then `.venv\Scripts\Activate.ps1` (if blocked: `Set-ExecutionPolicy -Scope Process Bypass`)
   - macOS: `python3 -m venv .venv` then `source .venv/bin/activate`
2. `pip install -r requirements.txt`

```bash
python build.py             # all regions in regions.json; the first run downloads ~1 GB for Ghana + NW India into data/raw/
python build.py portugal    # one region; Portugal's raw files are committed, so this needs no network
python build_country.py greece --delete-raw   # country tier (countries.json): grid only, no points; Brazil/Australia download ~2-3 GB each, Greece ~10 MB
python build_country.py --all --jobs 6 --skip-done --delete-raw   # the world: 176 countries, ~30 GB downloaded and deleted as it goes; re-run the same line after a failure
python model.py             # every region in regions.json (~16 min, peak ~2.4 GB): site/public/data/<region>/annual.json + series.json
python model.py portugal    # one region (~3 min); the inputs (data/grid/) are committed, so no build.py run is needed first
python model.py portugal --nboot 20   # quick dev run with fewer bootstrap draws; never commit its output
python model.py brazil      # one country (countries.json, after build_country.py): cell size picked for it, 100 draws, labelled by the ship rule
python run_countries.py --method ratio --jobs 4   # every country with a grid: the constant-ratio record, seconds each
python run_countries.py --method model --jobs 3 --until 04:00   # biggest fire first, upgrade to the cell model; no new country after 04:00 UTC; re-run to resume
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

Peak fire days (`peaks.py`, DP-016): `site/public/data/<region>/peaks.json` lists, for every month from 2001-01, the day with the most raw fire detections and the month's top 3 days (all cells, day and night), so the site can show that day's satellite image. Counts are raw, not harmonized; the sensor depends on the date (MODIS before 2012-01-20, VIIRS S-NPP to the archive end, NOAA-20 after) and is recorded per day. Reads `data/grid` only.

```bash
python peaks.py [region_id ...]   # default: all regions
```

### Data outputs (written by `build.py`)

- `regions.json` (hand-edited input): one entry per region: `id`, `name`, FIRMS `country` file name, `bbox` [west, south, east, north] (west/south edges inclusive, east/north exclusive; edge cells can stick out slightly when an edge isn't a multiple of 0.25°), `fire_type`. After editing a region's entry, rebuild that region (`python build.py <id>`) so its grid and the index match. The `punjab` box also covers part of Pakistani Punjab, but only India's FIRMS file is used for 2000–2025, so that side is empty. 2026 comes from the area API (whole box), so `build.py` keeps a 2026 detection only if its 0.05° sub-cell (~5.5 km) had a detection in the 2000–2025 archive. With whole 0.25° cells, about 6% of 2026 detections fell on ground with no detection in 2000–2024 (the neighbour's side of border cells, plus untyped NRT static sources); the 0.05° filter drops at most ~0.3% of genuine detections.
- `data/grid/fire_grid_daily_<region>.csv`: detections per 0.25° cell (south-west corner) × UTC day × day/night, per satellite, with mean fire radiative power: `terra_n`, `aqua_n`, `viirs_n` (VIIRS Suomi NPP; the model's input), their `*_frp_mean`, then `n20_n`, `n21_n` (VIIRS NOAA-20 / NOAA-21) and their `*_frp_mean`. Sparse: missing rows mean zero detections. Rows after 2 November 2026 hold NOAA counts only. NOAA rows never change the Terra/Aqua/S-NPP values.
- `data/grid/manifest.json`: per region, `archive_through` (last day the model's sensors, MODIS and S-NPP, cover) and per sensor (`terra`, `aqua`, `viirs`, `n20`, `n21`) `first_date` / `last_date` / `detections` / `data_through`. `last_date` is the **last day a fire was detected**, not the end of the data; `data_through` is how far that sensor's data reach: the last date in its raw archive files (before filtering) or its `fetch_recent.py` `through` (`null` = no data). S-NPP is capped at its end of life, 2026-11-02.
- `site/public/data/index.json`: the region list the website reads; `data_through` = `archive_through`; per sensor `first_date` / `last_date` / `data_through`; `point_years` / `point_rows` list the years and total rows of the point files.
- `countries.json` (hand-edited input) and `data/grid/country/` (written by `build_country.py`, git-ignored): whole countries for the country tier: every country with a FIRMS country archive (176, FIRMS file names checked with HEAD requests; not found: North Korea, North Macedonia, Iceland, Western Sahara, Malta, Liechtenstein), largest fire volume first, with `iso_a3`. Same fields as `regions.json` plus `tier` and `iso_a3`; `bbox` and `fire_type` optional. A year FIRMS has no file for (a tiny country with no fire that year) counts as no detections and is listed in the manifest's `missing_files`. `build_country.py` reads the same FIRMS country archive files year by year, grids each year at once (same `build.grid`) and keeps no detections, so a big country fits in memory and on disk; output `fire_grid_daily_<id>.csv` + `manifest.json` in the format `model.py` reads. Only the model's sensors are read (MODIS, VIIRS S-NPP; NOAA-20/21 only feed the 2026 forward link, which needs the area API), so the `n20_*`/`n21_*` columns are zero. Archive only (no key), so country data end at the archive end (2025-12-31). The model reads it with `model.run(<id>, grid_dir="data/grid/country")`. Each year is appended to a `.part` file, so a failed run leaves the old grid as it was; `--delete-raw` deletes only files the run downloaded, after their year is gridded. Checked: Portugal's files reproduce `data/grid/fire_grid_daily_portugal.csv`, and India's files cut to the NW India box reproduce the NW India grid, row for row.
- Whole countries in `model.py` (ML-023): the 0.25° grid is summed to the smallest cell size of 0.25/0.5/1/2/4/8° with at most 400 burning cells (counts summed, fire power weighted by counts; ML-024 found coarse cells keep the accuracy), 100 bootstrap draws. `--method ratio` skips the fit: before 2012 the ledger is MODIS times the country's 2012–2019 VIIRS/MODIS ratio (day and night apart, a Terra-only ratio before Aqua), with a band from the ratio's leave-one-year-out error; same files and fields as the model, about a second per country. A country's `annual.json` adds `tier`, `cell_deg` (null for the ratio), `method`, `ship`, `caveat` and `model_score`, and `series.json` adds the first four. `ship` is the label it is published with: `model` (the model beats one constant ratio on the hidden years 2020–2025 and at least 4 of the 6 fall inside its band), `caveat` (beats the ratio, band too narrow), `ratio` (the ratio method ran, or the ratio beat the model, in which case the model's score is kept in `model_score`) or `sparse` (too little fire to check: fewer than 1,000 VIIRS detections 2012–2019 or a year of 2012–2025 with none). `caveat` is the plain sentence the site shows for it, also naming missing FIRMS files and a 2001–2002 back-cast more than 1.5 times the 2003–2011 median. A country with no VIIRS or no MODIS at all in 2012–2019 stops with a message.
- `run_countries.py`: runs every country that has a grid, in `countries.json` order, one process per country (`model.py <id> --no-bundle`), skipping countries already at that method or better (a model run that lost to the ratio counts as done), so the same line resumes; `--redo` runs them again, `--only` picks ids. One failure doesn't stop the rest. After each country it rewrites `index.json`, `annual-all.json` and `globe.json`, so a commit at any moment is consistent. Each run is appended to `data/country_runs.csv` (finish time, id, method asked and published, label, cell size, seconds, hidden-year errors, years in band, error).
- `site/public/data/globe.json` (`globe.py`, run by `model.py` and `run_countries.py`): every region and country with an `annual.json` in one file for the globe and the scoreboard: `years` (complete years only, 2001–2025) and per region `id`, `name`, `tier`, `iso_a3` (countries), `bbox` (regions), `ship`, `method`, `cell_deg`, `caveat`, `harmonized`, `lo`/`hi` (only before 2012), the harmonized `trend` and the hidden-year `score`. Schema: registry row "Globe data".
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

Landing-page scene (`scripts/landing_scene/`, FE-019): the 360 frames in `site/public/scene/` that scroll behind the story on `/`. They are rendered with [Blender](https://www.blender.org) 5.3 from this repository's own files: NASA SRTM elevation of central Portugal (`scripts/landing_scene/srtm_tiles/`, four tiles, committed), the 2017 detections in `site/public/data/portugal/points/2017.csv`, and the harmonized monthly ledger in `site/public/data/portugal/series.json` (the closing calendar layout). `layout.py` (numpy only, covered by `tests/test_landing_scene.py`) decides where everything is on each frame; `scene.py` draws it. No models, textures or images are imported: the pines (around the opening viewpoint and over the hills round the fire, lit from below where the ground burns), the grass, smoke, sky, clouds, embers, the setting sun and the two plain satellites are built by the script. The story opens at the end of the afternoon of 17 June under scattered cloud, and the sun sets behind the fire as the page scrolls into the night while embers drift past the camera on its way up. In chapter 3 each satellite flies directly above the line it is scanning, with a fan of light from its instrument down to that line; the line crawls across the fire and moves fast only where there is nothing to detect, and Suomi NPP's 375 m re-scan crosses the fire about twice as slowly as Aqua's 1 km scan. Terrain heights are multiplied by 2.5.

```bash
# macOS path shown; on Windows use the full path to blender.exe. About 10 minutes for all 360 frames (Apple M2 Pro).
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

Claude was only used to accelerate development in such a short time, and was not used as a replacement for ideation. All design ideas, model creation strategies, training strategies, and model architectures were completely derived by humans before development of the actual project.

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
- NASA GIBS (Global Imagery Browse Services) WMS GetMap, true-colour corrected reflectance layers `MODIS_Terra_CorrectedReflectance_TrueColor`, `MODIS_Aqua_CorrectedReflectance_TrueColor`, `VIIRS_SNPP_CorrectedReflectance_TrueColor`, `VIIRS_NOAA20_CorrectedReflectance_TrueColor`, `VIIRS_NOAA21_CorrectedReflectance_TrueColor` — the "See it from space" image of a month's peak fire day on the burn calendar (`site/components/SpaceView.tsx`, loaded in the browser only when a month is opened; satellite picked by date) — https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi , docs https://nasa-gibs.github.io/gibs-api-docs/ — "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)." No key; NASA data, openly shared (CC0 unless marked).
- MERRA-2 reanalysis (the source POWER serves for these parameters) — https://doi.org/10.1175/JCLI-D-16-0758.1 — Gelaro, R., et al. (2017). The Modern-Era Retrospective Analysis for Research and Applications, Version 2 (MERRA-2). Journal of Climate, 30(14), 5419–5454.
- Saturation vapour pressure (Tetens form, `0.6108 exp(17.27 T / (T + 237.3))` kPa) for the vapour-pressure deficit in `weather.py` — FAO Irrigation and Drainage Paper 56, equation 11 — https://www.fao.org/4/x0490e/x0490e00.htm — Allen, R. G., Pereira, L. S., Raes, D., & Smith, M. (1998).
- MODIS active fire algorithm — method behind the MODIS detections — https://doi.org/10.1016/j.rse.2016.02.054 — Giglio, L., Schroeder, W., & Justice, C. O. (2016). The collection 6 MODIS active fire detection algorithm and fire products. Remote Sensing of Environment, 178, 31–41.
- MODIS burned area, MCD64CMQ Collection 6 (0.25° monthly climate-modelling-grid summary of MCD64A1) — burned area per region-month 2000-11 to 2022-12 for the independent check (`referee.py`) — https://doi.org/10.5067/MODIS/MCD64A1.006 — Giglio, L., Justice, C., Boschetti, L., & Roy, D. (2015). MCD64A1 MODIS/Terra+Aqua Burned Area Monthly L3 Global 500m SIN Grid V006 [Dataset]. NASA Land Processes Distributed Active Archive Center. MCD64CMQ has no DOI of its own; files from the University of Maryland SFTP server (MCD64 user guide §4.1, https://lpdaac.usgs.gov/documents/1006/MCD64_User_Guide_V61.pdf, checked 2026-11-15). No restrictions on use.
- MODIS burned area algorithm — method behind MCD64 — https://doi.org/10.1016/j.rse.2018.08.005 — Giglio, L., Boschetti, L., Roy, D. P., Humber, M. L., & Justice, C. O. (2018). The Collection 6 MODIS burned area mapping algorithm and product. Remote Sensing of Environment, 217, 72–85.
- VIIRS 375 m active fire algorithm — method behind the VIIRS detections — https://doi.org/10.1016/j.rse.2013.12.008 — Schroeder, W., Oliva, P., Giglio, L., & Csiszar, I. A. (2014). The New VIIRS 375 m active fire detection data product: Algorithm description and initial assessment. Remote Sensing of Environment, 143, 85–96.
- NASA Shuttle Radar Topography Mission Global 3 arc second (SRTM GL3, about 90 m), tiles N39W009, N39W008, N40W009, N40W008 (39-41 N, 9-7 W), committed in `scripts/landing_scene/srtm_tiles/` — the terrain of the landing-page scene (`scripts/landing_scene/`) — https://doi.org/10.5067/MEASURES/SRTM/SRTMGL3.003 — NASA JPL (2013). NASA Shuttle Radar Topography Mission Global 3 arc second [Data set]. NASA Land Processes Distributed Active Archive Center (DataCite record checked 2026-11-15). NASA data, openly shared without restriction. Downloaded as GeoTIFF from OpenTopography's public bulk-download bucket (`https://opentopography.s3.sdsc.edu/raster/SRTM_GL3/SRTM_GL3_srtm/North/North_30_60/<tile>.tif`, no login, fetched 2026-11-15): NASA Shuttle Radar Topography Mission (SRTM) (2013). Shuttle Radar Topography Mission (SRTM) Global. Distributed by OpenTopography. https://doi.org/10.5069/G9445JDF (DataCite record checked 2026-11-15).
- Natural Earth 1:110m Cultural Vectors, Admin 0 - Countries, v5.1.2 — the country outlines on the `/globe` page (FE-026) and each country's land area for detections per 1,000 km² — https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/ ; GeoJSON copy from the project's own repository, https://github.com/nvkelso/natural-earth-vector/blob/v5.1.2/geojson/ne_110m_admin_0_countries.geojson (fetched 2026-11-15) — public domain ("Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com", terms at https://www.naturalearthdata.com/about/terms-of-use/). Cut down by `scripts/globe/outlines.py` to `ISO_A3`, `ADM0_A3` and `NAME` with coordinates rounded to 0.01°, and French Guiana moved out of France into its own shape (FIRMS archives it as its own country), committed as `site/public/data/countries-110m.geojson` (172 KB).
- Pedrógão Grande fire, 17 June 2017 (the fire the landing page and its scene follow): place and date only; every detection drawn is from the FIRMS files above (`site/public/data/portugal/points/2017.csv`). The setting sun in the opening frames is placed at azimuth 300° (west-north-west), about where the sun sets at 40° N in mid-June (general astronomical fact; decoration, not data). Torre, Serra da Estrela (1,993 m, 40.3217 N, 7.6130 W) is used by `tests/test_landing_scene.py` to check that the SRTM mosaic is placed correctly (general geographic fact).

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
  - `turbopackFileSystemCache` docs (https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopackFileSystemCache): basis for turning off Turbopack's on-disk build cache in `site/next.config.ts`, after a restored Vercel build cache shipped stale theme CSS.
- React 19, React DOM: UI library. https://react.dev . MIT
- TypeScript: type checking. https://www.typescriptlang.org . Apache-2.0
- Tailwind CSS 4 (with @tailwindcss/turbopack): styling. https://tailwindcss.com . MIT
- shadcn/ui (`shadcn` CLI and copied component source in `site/components/ui/`): toggle group, tooltip, badge, separator, button. https://ui.shadcn.com . MIT
- cn: class-name merging used by shadcn/ui. https://github.com/shadcn-ui/cn . MIT
- Radix UI (`radix-ui`): accessible primitives under the shadcn/ui components. https://www.radix-ui.com . MIT
- class-variance-authority: component variants. https://cva.style . Apache-2.0
- tw-animate-css: animation utilities used by shadcn/ui. https://github.com/Wombosvideo/tw-animate-css . MIT
- Phosphor Icons (`@phosphor-icons/react`): icons. https://phosphoricons.com . MIT
- Work Sans (https://fonts.google.com/specimen/Work+Sans) and IBM Plex Mono (https://fonts.google.com/specimen/IBM+Plex+Mono) typefaces (via `next/font/google`): page typography for the red "Thermal console" theme (design from Mission Control `reference/Ideas_2026-11-15.md` §4, scheme A). SIL Open Font License 1.1
- globe.gl 2.46.2: the WebGL 3D globe on `/globe` (FE-026; polygons, atmosphere, orbit controls, tooltip), loaded only on that page after first paint. https://github.com/vasturiano/globe.gl . MIT
  - Bundled with it (its own dependencies, nothing imported directly by our code): three.js 0.187.0 (https://threejs.org, MIT), three-globe, three-render-objects, three-conic-polygon-geometry, three-geojson-geometry, three-slippy-map-globe, kapsule, accessor-fn, float-tooltip, data-bind-mapper, frame-ticker, index-array-by, simplesignal (all https://github.com/vasturiano, MIT); @tweenjs/tween.js (MIT); h3-js (Uber, Apache-2.0); earcut, delaunator (Mapbox, ISC); d3-array, d3-color, d3-delaunay, d3-format, d3-geo-voronoi, d3-interpolate, d3-scale, d3-scale-chromatic, d3-selection, d3-time, d3-time-format, d3-tricontour, internmap (ISC); d3-octree, @turf/boolean-point-in-polygon, @turf/helpers, @turf/invariant, point-in-polygon-hao, polished, preact, tinycolor2, lodash-es, @babel/runtime (MIT); robust-predicates (Unlicense); tslib (0BSD). Exact versions in `site/package-lock.json`.
- d3-geo 3.1.1: spherical polygon areas (`geoArea`) for detections per 1,000 km² and centroids to turn the globe to a country (`site/lib/globe.ts`, `site/components/globe/GlobeCanvas.tsx`); types from @types/d3-geo and @types/geojson (MIT). https://d3js.org/d3-geo . ISC
- ESLint, eslint-config-next, babel-plugin-react-compiler: linting and build tooling. https://eslint.org , https://react.dev/learn/react-compiler . MIT

Code

- `site/fixtures/series.portugal.sample.json`: test fixture built from this repo's Portugal grid (then `fire_grid_daily.csv`, now `data/grid/fire_grid_daily_portugal.csv`; NASA FIRMS data above); its harmonized values are placeholders, not model output.
- The burn calendar (`/calendar`) reads this project's own model export, `site/public/data/<region>/series.json` (harmonized monthly counts from `model.py`, month medians, middle half and unusual-month flags from `calendar_stats.py`; NASA FIRMS data above). The fire-season line per region is reworded from `site/public/data/index.json` (team-written region notes). No new library, data source or asset.
- `peaks.py`: no new data source (reads `data/grid`; NASA FIRMS data above).
- The ledger chart in `site/components/RecordChart.tsx` is ported from this project's own proof-of-concept page (`web/index.html`, commit `051327a`).
- Region switcher, date range and downloads (`site/components/RegionSwitcher.tsx`, `DateRange.tsx`, `DownloadCsv.tsx`, `site/lib/selection.ts`): the region list and dates come from this project's own `site/public/data/index.json`; "Download CSV" and "Download analytics" call this project's own `/api/hotspots` and `/api/series` route handlers; the whole-year links point to this project's own `site/public/data/<region>/points/<year>.csv` files (all NASA FIRMS data above, with the FIRMS acknowledgment shown next to the buttons). Uses the browser's built-in date and select inputs; no new library, data source or asset.
- Latitude/longitude box for the hotspot CSV (`site/components/BoxFilter.tsx`, box helpers in `site/lib/selection.ts`, `useBox` in `site/lib/use-selection.ts`): four typed edges, kept in the URL as `?bbox=w,s,e,n` and passed to this project's own `/api/hotspots` `bbox` filter; the region boxes it checks against come from this project's own `regions.json` via `site/public/data/index.json` (NASA FIRMS data above). Plain text inputs; no new library, data source or asset.
- Partial-year handling in the ledger chart (`site/lib/annual.ts`, `site/components/RecordChart.tsx`): reads the `partial` and `data_through` fields of this project's own `site/public/data/<region>/annual.json` (written by `model.py`; NASA FIRMS data above, including the 2026 area-API rows). The model years (VIIRS from 2012, hold-out from 2020) mirror `model.py`. No new library, data source or asset.
- Trend block in `annual.json` (`trend_stats.py`, called by `model.py`): Theil-Sen slope with a 90% interval and the Mann-Kendall trend test, on the naive stitched ledger and the harmonized ledger of this project's own model output (NASA FIRMS data above). Methods: Sen, P. K. (1968), "Estimates of the regression coefficient based on Kendall's tau", JASA 63(324), 1379–1389; Mann, H. B. (1945), "Nonparametric tests against trend", Econometrica 13(3), 245–259; implemented with scipy (above). No new library or data source.
- Landing-page scene (`scripts/landing_scene/srtm.py`, `layout.py`, `scene.py`, `tests/test_landing_scene.py`): written for this project. Terrain from the SRTM tiles above; squares from this project's own `site/public/data/portugal/points/2017.csv`, at the nominal pixel sizes (MODIS 1 km, VIIRS 375 m) already cited above; the calendar layout from this project's own `site/public/data/portugal/series.json`. The trees, grass, smoke, sky, clouds (two procedural noise fields in the world shader), sun, embers (camera-facing discs moved by the script; decoration, not detections), satellites, scan lines and their light fans are simple shapes and shader gradients made by the script: no 3D model, texture, HDRI or NASA media is used. The slope limiter in the camera curve is the standard Fritsch-Carlson monotone cubic: Fritsch, F. N., & Carlson, R. E. (1980). Monotone piecewise cubic interpolation. SIAM Journal on Numerical Analysis, 17(2), 238-246. https://doi.org/10.1137/0717021
- Scroll scene on `/` (`site/lib/scene.ts`, `site/components/story/StoryScene.tsx`, `StorySceneGate.tsx`, "Scroll scene" in `site/app/globals.css`): written for this project; draws the frames in `site/public/scene/` on a `<canvas>` with browser APIs only (`fetch`, `createImageBitmap`, `requestAnimationFrame`, `ResizeObserver`, `matchMedia`), no added package. Between two frames it fades the next one over the current one (canvas `globalAlpha`), and the glide towards the scroll position is an exponential ease on elapsed time, so it runs the same at 60 Hz and 120 Hz; both written for this project.
- 3D globe page `/globe` (FE-026: `site/app/globe/page.tsx`, `site/components/globe/GlobeExplorer.tsx`, `GlobeCanvas.tsx`, `site/lib/globe.ts`, `globe-server.ts`, `globe.test.ts`, `scripts/globe/outlines.py`): written for this project. Numbers from this project's own `site/public/data/globe.json` (ML-023's `globe.py`), or until it is committed each region's own `annual.json` (NASA FIRMS data above); outlines and areas from Natural Earth (above), area = d3-geo spherical area × the IUGG mean Earth radius 6,371.0088 km (Moritz, H. (2000). Geodetic Reference System 1980. Journal of Geodesy 74, 128-133, https://doi.org/10.1007/s001900050278). The 2001-2025 trend and its significance are the ML-020 Theil-Sen / Mann-Kendall block already cited above. Colours are the site's own theme plus ramps written for this project. Kosovo's FIRMS code `XKX` is matched to Natural Earth's `KOS`. The deep-dive boxes come from this project's own `regions.json`.
- Project scaffold from `create-next-app` (MIT). https://nextjs.org/docs/app/api-reference/cli/create-next-app

Images

- `site/public/scene/f000.webp` to `f359.webp` (360 frames, 1600 x 900): rendered by this project with Blender from `scripts/landing_scene/scene.py` (SRTM elevation and FIRMS detections cited above). No third-party image, model or texture.
- `site/app/icon.svg` (the site icon, "Pixel Flame"): drawn for this project as plain SVG squares; coarse cells on the left and fine cells on the right stand for the MODIS 1 km and VIIRS 375 m pixel sizes cited above. Colours are the site's own theme colours. Served by Next.js's `icon` file convention (https://nextjs.org/docs/app/api-reference/file-conventions/metadata/app-icons). No third-party image, icon set or font.

AI

- Claude (Anthropic): code, text and documentation assistance. https://www.anthropic.com/claude
