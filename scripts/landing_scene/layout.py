"""Where everything is on each frame of the landing-page scene (FE-019). Pure numpy, no Blender.

`scene.py` (run by Blender) draws what this module computes; tests/test_landing_scene.py checks it against the
published data. Units: kilometres. x = east, y = north of 40 N, 8 W (the middle of the four SRTM tiles); z = up,
terrain heights multiplied by EXAG.

The 360 frames follow the six chapters of the story page (site/app/page.tsx); frame ANCHORS[k] is what the canvas
shows when chapter k+1 is in the middle of the window. Everything below is keyed in story time t, 0 to 179 (one unit
per frame of the first, 180-frame cut); story_time() maps a rendered frame to t, so the frame count can change
without moving anything in the story.

  t   0 (frame   0)  forest floor at the end of the afternoon of 17 June 2017, the Pedrógão Grande fire on the
                     hills ahead; the sun sets behind it as the page scrolls
     36 (frame  72)  night, above the smoke, the fire below
     72 (frame 144)  far above, looking straight down; Aqua (1 km pixels) then, slower, Suomi NPP (375 m) have
                     just crossed
    108 (frame 216)  pulled back; every 2017 detection in the area has switched on, in date order
    144 (frame 288)  the squares have fallen into a timeline: one column per day of 2017
    179 (frame 359)  the squares have settled into 26 x 12 cells, in proportion to the harmonized monthly record
"""
import csv
import json
import math
from pathlib import Path

import numpy as np

import srtm  # the folder of this file is on sys.path (scene.py and the tests put it there)

FRAMES = 360
ANCHORS = (0, 72, 144, 216, 288, 359)
STORY_ANCHORS = (0, 36, 72, 108, 144, 179)  # the same six moments in story time


def story_time(frame: float) -> float:
    """Story time t (0-179, what every key below uses) of a rendered frame (0 to FRAMES - 1), exact at the anchors."""
    return float(np.interp(frame, ANCHORS, STORY_ANCHORS))

# From here on, every `frame` argument and every frame key (CLOCK, PASSES, CAMERA, the layout moves) is story time t.


LAT_C, LON_C = 40.0, -8.0
KM_LAT = 111.195
KM_LON = KM_LAT * math.cos(math.radians(LAT_C))
EXAG = 2.5  # vertical exaggeration of the terrain

YEAR = 2017
PIXEL_KM = {"modis": 1.0, "viirs": 0.375}  # nominal pixel edge at nadir (site/lib/story.ts PIXEL_M)
MODIS = ("Terra", "Aqua")

# The two overpasses of chapter 3 (site/lib/story.ts closestPair on 2017-06-18): they switch on under the scan line
# of the satellite that made them, south to north, instead of all at once.
STORY_DAY = "2017-06-18"
PASSES = (
    {"satellite": "Aqua", "from": "1250", "to": "1257", "frames": (47.0, 55.0),
     "track": ((47.0, -42.0), (48.5, -14.0), (54.0, 14.0), (55.0, 36.0))},
    {"satellite": "SNPP", "from": "1325", "to": "1332", "frames": (57.5, 71.0),
     "track": ((57.5, -64.0), (59.5, -14.0), (69.0, 14.0), (71.0, 36.0))},
)
# "track": (frame, km along the track from the scene centre) keys of each pass's scan line, linear between them. The
# line enters the picture fast, slows to a crawl over the fire (the middle key pair, +-14 km around it, where every
# detection but one SNPP outlier lies) and leaves fast. Suomi NPP's 375 m re-scan gets the slowest crossing (9.5
# frames over the fire against Aqua's 5.5), so its finer squares visibly fill in behind the line. The first and last
# keys start and end outside the picture and outside every detection of the pass (a test checks it).
TRACK_AZ = -12.0  # both are ascending (northbound) daytime passes; ground track about 12 degrees west of north
TRACK = (math.sin(math.radians(TRACK_AZ)), math.cos(math.radians(TRACK_AZ)))
CROSS = (TRACK[1], -TRACK[0])  # across the track, to the east-north-east

Z_PLANE = 12.0  # height of the flat timeline and calendar layouts, above the peaks and the smoke
HIST = {"x0": -95.0, "x1": 95.0, "y0": -56.0, "sub": 5, "gap": 0.1}  # low in the picture: the page's text sits mid-screen
GRID = {"pitch": 7.0, "inner": 6.2, "years": 26, "months": 12}
SIZE_HIST = 0.085
SIZE_GRID = 0.16


def project(lat, lon):
    """Latitude and longitude (degrees) to scene x, y in km."""
    return (np.asarray(lon) - LON_C) * KM_LON, (np.asarray(lat) - LAT_C) * KM_LAT


def minute_of_year(date: str, hhmm: str) -> float:
    """Minutes since 1 January of YEAR, 00:00 UTC."""
    y, m, d = (int(v) for v in date.split("-"))
    days = (np.datetime64(f"{y:04d}-{m:02d}-{d:02d}") - np.datetime64(f"{YEAR}-01-01")).astype(int)
    hhmm = hhmm.zfill(4)
    return float(days) * 1440 + int(hhmm[:2]) * 60 + int(hhmm[2:])


def load_points(path: Path) -> dict:
    """
    The detections of points/<YEAR>.csv inside the four SRTM tiles, in time order (ties keep file order).
    Returns arrays: x, y (km), t (minutes of year), day (0-based day of year), modis (bool), and a list `satellite`.
    """
    rows = []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            lat, lon = float(r["lat"]), float(r["lon"])
            if not (srtm.LAT0 <= lat <= srtm.LAT1 and srtm.LON0 <= lon <= srtm.LON1):
                continue
            rows.append((minute_of_year(r["date"], r["time_utc"]), lat, lon, r["satellite"], r["date"], r["time_utc"].zfill(4)))
    rows.sort(key=lambda r: r[0])
    t = np.array([r[0] for r in rows])
    x, y = project(np.array([r[1] for r in rows]), np.array([r[2] for r in rows]))
    return {
        "x": x, "y": y, "t": t,
        "day": (t // 1440).astype(int),
        "modis": np.array([r[3] in MODIS for r in rows]),
        "satellite": [r[3] for r in rows],
        "date": [r[4] for r in rows],
        "time": [r[5] for r in rows],
    }


def height_km(dem: np.ndarray, x, y) -> np.ndarray:
    """Terrain height in scene km (already exaggerated) at scene x, y, bilinear; 0 outside the tiles."""
    x, y = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    per = srtm.SIZE - 1
    c = (x / KM_LON + LON_C - srtm.LON0) * per
    r = (srtm.LAT1 - (y / KM_LAT + LAT_C)) * per
    inside = (c >= 0) & (c <= dem.shape[1] - 1) & (r >= 0) & (r <= dem.shape[0] - 1)
    c0 = np.clip(np.floor(c).astype(int), 0, dem.shape[1] - 2)
    r0 = np.clip(np.floor(r).astype(int), 0, dem.shape[0] - 2)
    fc, fr = np.clip(c - c0, 0, 1), np.clip(r - r0, 0, 1)
    z = (dem[r0, c0] * (1 - fc) * (1 - fr) + dem[r0, c0 + 1] * fc * (1 - fr)
         + dem[r0 + 1, c0] * (1 - fc) * fr + dem[r0 + 1, c0 + 1] * fc * fr)
    return np.where(inside, z, 0.0) / 1000.0 * EXAG


def surface_km(dem: np.ndarray, x, y, step: int = 2) -> np.ndarray:
    """
    Height (scene km) of the terrain mesh scene.py draws, at scene x, y: every `step`-th sample, each grid square
    split into two triangles along its north-west to south-east diagonal. Grass and trees stand on this surface, so
    they neither float above it nor sink into it where the coarser mesh and the full grid (height_km) differ.
    0 outside the tiles.
    """
    x, y = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    d = dem[::step, ::step]
    per = (srtm.SIZE - 1) / step
    c = (x / KM_LON + LON_C - srtm.LON0) * per
    r = (srtm.LAT1 - (y / KM_LAT + LAT_C)) * per
    inside = (c >= 0) & (c <= d.shape[1] - 1) & (r >= 0) & (r <= d.shape[0] - 1)
    c0 = np.clip(np.floor(c).astype(int), 0, d.shape[1] - 2)
    r0 = np.clip(np.floor(r).astype(int), 0, d.shape[0] - 2)
    fc, fr = np.clip(c - c0, 0, 1), np.clip(r - r0, 0, 1)
    z00, z10 = d[r0, c0].astype(float), d[r0 + 1, c0].astype(float)
    z11, z01 = d[r0 + 1, c0 + 1].astype(float), d[r0, c0 + 1].astype(float)
    z = np.where(fr >= fc, z00 + fr * (z10 - z00) + fc * (z11 - z10), z00 + fc * (z01 - z00) + fr * (z11 - z01))
    return np.where(inside, z, 0.0) / 1000.0 * EXAG


def mesh_faces(rows: int, cols: int) -> np.ndarray:
    """Triangles of a rows x cols grid of vertices (row-major), split the way surface_km assumes, facing up."""
    i = np.arange(rows * cols).reshape(rows, cols)
    a, b, c, d = i[:-1, :-1].ravel(), i[1:, :-1].ravel(), i[1:, 1:].ravel(), i[:-1, 1:].ravel()
    return np.concatenate([np.stack([a, b, c], axis=1), np.stack([a, c, d], axis=1)])


# ---------------------------------------------------------------------------------------------------------------
# Time: which detections are on at each frame
# ---------------------------------------------------------------------------------------------------------------

def _m(date: str, hhmm: str) -> float:
    return minute_of_year(date, hhmm)


# (frame, minute of year): the scene's clock, linear between the keys. Everything before frame 0's time is already
# on (and cold) when the story opens; the clock reaches the end of the year at frame 108.
CLOCK = (
    (0.0, _m("2017-06-18", "0300")),
    (36.0, _m("2017-06-18", "1240")),
    (47.0, _m("2017-06-18", "1250")),  # Aqua's pass (PASSES)
    (55.0, _m("2017-06-18", "1257")),
    (57.5, _m("2017-06-18", "1325")),  # Suomi NPP's pass
    (72.0, _m("2017-06-18", "1335")),
    (108.0, _m("2017-12-31", "2359")),
)


def along_track(x, y):
    """Distance along the satellites' ground track (km from the scene centre)."""
    return np.asarray(x) * TRACK[0] + np.asarray(y) * TRACK[1]


def scan_line(frame: float):
    """(pass, km along the track) for the scan line crossing the scene at `frame`, or None between passes."""
    for ps in PASSES:
        f0, f1 = ps["frames"]
        if f0 <= frame <= f1:
            kf, km = zip(*ps["track"])
            return ps, float(np.interp(frame, kf, km))
    return None


def clock(frame: float) -> float:
    """Minute of the year the scene has reached at `frame`."""
    return float(np.interp(frame, [k[0] for k in CLOCK], [k[1] for k in CLOCK]))


def on_frames(p: dict) -> np.ndarray:
    """The frame at which each detection switches on (negative = before the story opens)."""
    kf, kt = np.array([k[0] for k in CLOCK]), np.array([k[1] for k in CLOCK])
    out = np.interp(p["t"], kt, kf, left=-1.0)
    for ps in PASSES:
        t0, t1 = _m(STORY_DAY, ps["from"]), _m(STORY_DAY, ps["to"])
        sel = np.array([s == ps["satellite"] for s in p["satellite"]]) & (p["t"] >= t0) & (p["t"] <= t1)
        kf, km = zip(*ps["track"])
        out[sel] = np.interp(along_track(p["x"][sel], p["y"][sel]), km, kf)
    return out


def heat(p: dict, on: np.ndarray, frame: float) -> np.ndarray:
    """
    Glow of each detection at `frame`, 0..1: 0 until it switches on, then 1 cooling to a faint 0.2 (two days in
    scene time, or a few frames of scrolling, whichever keeps it brighter). They all light again as they leave the
    ground for the timeline.
    """
    age_days = (clock(frame) - p["t"]) / 1440.0
    h = np.maximum(np.exp(-np.maximum(age_days, 0) / 2.0), np.exp(-np.maximum(frame - on, 0) / 5.0))
    h = np.where(on <= frame, np.maximum(h, 0.2), 0.0)
    return np.maximum(h, to_timeline(len(on), frame) * 0.8)


# ---------------------------------------------------------------------------------------------------------------
# Layouts: ground -> timeline -> calendar
# ---------------------------------------------------------------------------------------------------------------

def _ease(u):
    u = np.clip(u, 0.0, 1.0)
    return u * u * (3 - 2 * u)


def to_timeline(n: int, frame: float) -> np.ndarray:
    """0..1 progress of each square (in time order) from the ground to its timeline slot, frames 108 to 144."""
    start = 108.0 + 20.0 * np.arange(n) / max(n - 1, 1)
    return _ease((frame - start) / 14.0)


def to_calendar(n: int, frame: float) -> np.ndarray:
    """0..1 progress of each square from the timeline to its calendar cell, frames 146 to 176."""
    start = 146.0 + 16.0 * np.arange(n) / max(n - 1, 1)
    return _ease((frame - start) / 14.0)


def timeline_slots(day: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    One column per day of the year, squares stacked from the baseline in time order: a daily histogram of the
    detections, HIST["sub"] squares wide. `day` must be sorted (load_points order).
    """
    days = 366 if (YEAR % 4 == 0 and (YEAR % 100 != 0 or YEAR % 400 == 0)) else 365
    pitch_day = (HIST["x1"] - HIST["x0"]) / days
    pitch = pitch_day * (1 - HIST["gap"]) / HIST["sub"]
    first = np.searchsorted(day, day, side="left")  # index of the first detection of the same day
    j = np.arange(len(day)) - first
    x = HIST["x0"] + day * pitch_day + (j % HIST["sub"] + 0.5) * pitch
    y = HIST["y0"] + (j // HIST["sub"] + 0.5) * pitch
    return x, y


def monthly_harmonized(series_path: Path) -> tuple[int, np.ndarray]:
    """(first year, harmonized detections per month) from a published series.json: VIIRS where observed, else pred."""
    m = json.loads(Path(series_path).read_text())["monthly"]
    v = np.array([a if a is not None else (b if b is not None else 0.0) for a, b in zip(m["viirs"], m["pred"])], dtype=float)
    return int(m["start_year"]), v


def shares(values: np.ndarray, n: int) -> np.ndarray:
    """Splits n squares over the cells in proportion to `values` (largest remainder), so the counts add up to n."""
    v = np.maximum(np.asarray(values, dtype=float), 0)
    if v.sum() <= 0:
        raise ValueError("no positive values to share squares over")
    exact = v / v.sum() * n
    base = np.floor(exact).astype(int)
    left = n - int(base.sum())
    if left:
        base[np.argsort(-(exact - base), kind="stable")[:left]] += 1
    return base


def calendar_slots(values: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    26 columns (years) x 12 rows (January at the top). Each cell holds squares in proportion to its month's value,
    filling outward from the cell's centre, so a cell's lit area is proportional to that month's detections.
    Squares are dealt out in order, cell by cell (year, then month). Returns x, y and the cell index of each square.
    """
    cells = GRID["years"] * GRID["months"]
    if len(values) > cells:
        raise ValueError(f"{len(values)} months do not fit {GRID['years']} x {GRID['months']} cells: raise GRID['years']")
    v = np.zeros(cells)
    v[: len(values)] = values
    count = shares(v, n)
    k = int(math.ceil(math.sqrt(count.max())))
    pitch = GRID["inner"] / k
    off = np.arange(k) - (k - 1) / 2
    ii, jj = np.meshgrid(off, off)
    ring = np.maximum(np.abs(ii), np.abs(jj)).ravel()
    order = np.lexsort((np.arctan2(jj, ii).ravel(), ring))  # rings outward from the centre
    ox, oy = ii.ravel()[order] * pitch, jj.ravel()[order] * pitch
    cell = np.repeat(np.arange(cells), count)
    slot = np.arange(n) - np.repeat(np.cumsum(count) - count, count)
    year, month = cell // GRID["months"], cell % GRID["months"]
    x = (year - (GRID["years"] - 1) / 2) * GRID["pitch"] + ox[slot]
    y = ((GRID["months"] - 1) / 2 - month) * GRID["pitch"] + oy[slot]
    return x, y, cell


def squares(p: dict, ground_z: np.ndarray, on: np.ndarray, slots_t, slots_c, frame: float):
    """Position (n x 3), edge length and glow of every detection square at `frame`."""
    n = len(on)
    u, v = to_timeline(n, frame), to_calendar(n, frame)
    lift = np.where(p["modis"], 0.02, 0.05)  # VIIRS squares sit just above the MODIS ones they overlap
    gx, gy, gz = p["x"], p["y"], ground_z + lift
    tx, ty = slots_t
    cx, cy = slots_c
    x = gx + (tx - gx) * u
    y = gy + (ty - gy) * u
    z = gz + (Z_PLANE - gz) * u + np.sin(np.pi * u) * 6.0
    x = x + (cx - x) * v
    y = y + (cy - y) * v
    z = z + np.sin(np.pi * v) * 3.0
    size = np.where(p["modis"], PIXEL_KM["modis"], PIXEL_KM["viirs"])
    size = size + (SIZE_HIST - size) * u
    size = size + (SIZE_GRID - size) * v
    return np.stack([x, y, z], axis=1), size, heat(p, on, frame)


# ---------------------------------------------------------------------------------------------------------------
# Camera
# ---------------------------------------------------------------------------------------------------------------

# The fire: the middle of the Pedrógão Grande detections of 17-18 June 2017.
FIRE = (-13.6, -1.1)
# Where the story opens: the ground point 7 to 13 km from the fire that sees the most of it (viewpoint() below).
EYE = (-4.55, -10.05)

# (frame, eye x, y, height, target x, y, height, focal length mm, ground). Heights are km above the ground under the
# eye (or under the target) while `ground` is 1, and above sea level when it is 0; in between they blend.
CAMERA = (
    (0.0,   EYE[0], EYE[1], 0.004, FIRE[0], FIRE[1], 0.5, 20.0, 1.0),
    (12.0,  EYE[0], EYE[1], 0.035, FIRE[0], FIRE[1], 0.5, 20.0, 1.0),
    (24.0,  -4.6,   -10.0,  0.9,   FIRE[0], FIRE[1], 0.2, 22.0, 1.0),
    (36.0,  -5.0,   -9.6,   5.0,   FIRE[0], FIRE[1], 0.0, 26.0, 1.0),
    (54.0,  -11.5,  -3.0,   60.0,  FIRE[0], FIRE[1], 0.0, 35.0, 0.0),
    (72.0,  -13.6,  -1.6,   105.0, FIRE[0], FIRE[1], 0.0, 35.0, 0.0),
    (108.0, 0.0,    -0.5,   215.0, 0.0,     0.0,     0.0, 35.0, 0.0),
    (144.0, 0.0,    -0.5,   232.0, 0.0,     0.0,     0.0, 35.0, 0.0),
    (179.0, 0.0,    -0.5,   232.0, 0.0,     0.0,     0.0, 35.0, 0.0),
)


def _spline(frames: np.ndarray, values: np.ndarray, f: float) -> np.ndarray:
    """
    Smooth curve through the keys with no overshoot (cubic Hermite, Fritsch-Carlson limited slopes, flat at both
    ends): between two keys every value stays between the keys' values, so the camera never dips or backs up.
    """
    f = float(np.clip(f, frames[0], frames[-1]))
    i = int(np.clip(np.searchsorted(frames, f, side="right") - 1, 0, len(frames) - 2))
    f0, f1 = frames[i], frames[i + 1]
    u = (f - f0) / (f1 - f0)

    def slope(k):
        if k == 0 or k == len(frames) - 1:
            return np.zeros_like(values[0])
        before = (values[k] - values[k - 1]) / (frames[k] - frames[k - 1])
        after = (values[k + 1] - values[k]) / (frames[k + 1] - frames[k])
        centred = (values[k + 1] - values[k - 1]) / (frames[k + 1] - frames[k - 1])
        limit = 3 * np.minimum(np.abs(before), np.abs(after))
        return np.where(before * after > 0, np.clip(centred, -limit, limit), 0.0)

    m0, m1 = slope(i) * (f1 - f0), slope(i + 1) * (f1 - f0)
    h00, h10 = 2 * u**3 - 3 * u**2 + 1, u**3 - 2 * u**2 + u
    h01, h11 = -2 * u**3 + 3 * u**2, u**3 - u**2
    return h00 * values[i] + h10 * m0 + h01 * values[i + 1] + h11 * m1


def camera(dem: np.ndarray, frame: float) -> dict:
    """Eye and target (scene km) and focal length at `frame`."""
    keys = np.array(CAMERA, dtype=float)
    k = _spline(keys[:, 0], keys[:, 1:], frame)
    ex, ey, eh, tx, ty, th, mm, ground = k
    ground = float(np.clip(ground, 0, 1))
    # heights are in log space between keys so the climb from 4 m to 100 km reads as one steady pull
    logh = _spline(keys[:, 0], np.log(keys[:, 3:4]), frame)[0]
    eh = float(np.exp(logh))
    ez = eh + ground * float(height_km(dem, ex, ey))
    tz = max(th, 0.0) + ground * float(height_km(dem, tx, ty))
    return {"eye": (float(ex), float(ey), float(ez)), "target": (float(tx), float(ty), float(tz)), "mm": float(mm)}


def viewpoint(dem: np.ndarray, p: dict, until: float, near: float = 7.0, far: float = 13.0, step: float = 0.45):
    """
    Finds where the story opens: the ground point between `near` and `far` km from the fire from which a person
    (2 m eye height) sees the most detections that are on by minute `until`. Returns ((x, y), seen, total).
    """
    sel = (p["t"] <= until) & (p["t"] >= until - 1440) & (np.hypot(p["x"] - FIRE[0], p["y"] - FIRE[1]) < 25)
    tx, ty = p["x"][sel], p["y"][sel]
    tz = height_km(dem, tx, ty) + 0.02
    best = ((0.0, 0.0), -1)
    s = np.linspace(0.02, 0.98, 48)[None, :]
    for cx in np.arange(FIRE[0] - far, FIRE[0] + far, step):
        for cy in np.arange(FIRE[1] - far, FIRE[1] + far, step):
            d = math.hypot(cx - FIRE[0], cy - FIRE[1])
            if not near <= d <= far:
                continue
            cz = float(height_km(dem, cx, cy)) + 0.002
            px = cx + (tx[:, None] - cx) * s
            py = cy + (ty[:, None] - cy) * s
            pz = cz + (tz[:, None] - cz) * s
            seen = int(np.all(height_km(dem, px, py) < pz, axis=1).sum())
            if seen > best[1]:
                best = ((round(float(cx), 2), round(float(cy), 2)), seen)
    return best[0], best[1], int(sel.sum())
