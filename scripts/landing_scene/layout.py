import csv
import json
import math
from pathlib import Path

import numpy as np

import srtm

FRAMES = 360
ANCHORS = (0, 72, 144, 216, 288, 359)
STORY_ANCHORS = (0, 36, 72, 108, 144, 179)


def story_time(frame: float) -> float:
    return float(np.interp(frame, ANCHORS, STORY_ANCHORS))


LAT_C, LON_C = 40.0, -8.0
KM_LAT = 111.195
KM_LON = KM_LAT * math.cos(math.radians(LAT_C))
EXAG = 2.5

YEAR = 2017
PIXEL_KM = {"modis": 1.0, "viirs": 0.375}
MODIS = ("Terra", "Aqua")

STORY_DAY = "2017-06-18"
PASSES = (
    {"satellite": "Aqua", "from": "1250", "to": "1257", "frames": (47.0, 55.0),
     "track": ((47.0, -42.0), (48.5, -14.0), (54.0, 14.0), (55.0, 36.0))},
    {"satellite": "SNPP", "from": "1325", "to": "1332", "frames": (57.5, 71.0),
     "track": ((57.5, -64.0), (59.5, -14.0), (69.0, 14.0), (71.0, 36.0))},
)
TRACK_AZ = -12.0
TRACK = (math.sin(math.radians(TRACK_AZ)), math.cos(math.radians(TRACK_AZ)))
CROSS = (TRACK[1], -TRACK[0])

Z_PLANE = 12.0
HIST = {"x0": -95.0, "x1": 95.0, "y0": -56.0, "sub": 5, "gap": 0.1}
GRID = {"pitch": 7.0, "inner": 6.2, "years": 26, "months": 12}
SIZE_HIST = 0.085
SIZE_GRID = 0.16


def project(lat, lon):
    return (np.asarray(lon) - LON_C) * KM_LON, (np.asarray(lat) - LAT_C) * KM_LAT


def minute_of_year(date: str, hhmm: str) -> float:
    y, m, d = (int(v) for v in date.split("-"))
    days = (np.datetime64(f"{y:04d}-{m:02d}-{d:02d}") - np.datetime64(f"{YEAR}-01-01")).astype(int)
    hhmm = hhmm.zfill(4)
    return float(days) * 1440 + int(hhmm[:2]) * 60 + int(hhmm[2:])


def load_points(path: Path) -> dict:
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
    i = np.arange(rows * cols).reshape(rows, cols)
    a, b, c, d = i[:-1, :-1].ravel(), i[1:, :-1].ravel(), i[1:, 1:].ravel(), i[:-1, 1:].ravel()
    return np.concatenate([np.stack([a, b, c], axis=1), np.stack([a, c, d], axis=1)])


def _m(date: str, hhmm: str) -> float:
    return minute_of_year(date, hhmm)


CLOCK = (
    (0.0, _m("2017-06-18", "0300")),
    (36.0, _m("2017-06-18", "1240")),
    (47.0, _m("2017-06-18", "1250")),
    (55.0, _m("2017-06-18", "1257")),
    (57.5, _m("2017-06-18", "1325")),
    (72.0, _m("2017-06-18", "1335")),
    (108.0, _m("2017-12-31", "2359")),
)


def along_track(x, y):
    return np.asarray(x) * TRACK[0] + np.asarray(y) * TRACK[1]


def scan_line(frame: float):
    for ps in PASSES:
        f0, f1 = ps["frames"]
        if f0 <= frame <= f1:
            kf, km = zip(*ps["track"])
            return ps, float(np.interp(frame, kf, km))
    return None


def flight(ps: dict, frame: float) -> float:
    kf, km = zip(*ps["track"])
    if frame < kf[0]:
        return km[0] + (frame - kf[0]) * (km[1] - km[0]) / (kf[1] - kf[0])
    if frame > kf[-1]:
        return km[-1] + (frame - kf[-1]) * (km[-1] - km[-2]) / (kf[-1] - kf[-2])
    return float(np.interp(frame, kf, km))


def clock(frame: float) -> float:
    return float(np.interp(frame, [k[0] for k in CLOCK], [k[1] for k in CLOCK]))


def on_frames(p: dict) -> np.ndarray:
    kf, kt = np.array([k[0] for k in CLOCK]), np.array([k[1] for k in CLOCK])
    out = np.interp(p["t"], kt, kf, left=-1.0)
    for ps in PASSES:
        t0, t1 = _m(STORY_DAY, ps["from"]), _m(STORY_DAY, ps["to"])
        sel = np.array([s == ps["satellite"] for s in p["satellite"]]) & (p["t"] >= t0) & (p["t"] <= t1)
        kf, km = zip(*ps["track"])
        out[sel] = np.interp(along_track(p["x"][sel], p["y"][sel]), km, kf)
    return out


PASS_DIM = (((40.0, 46.0), (55.0, 57.5)), 0.3)


def heat(p: dict, on: np.ndarray, frame: float) -> np.ndarray:
    age_days = (clock(frame) - p["t"]) / 1440.0
    cooling = np.exp(-np.maximum(age_days, 0) / 2.0)
    spans, dim = PASS_DIM
    for ps, (f0, f1) in zip(PASSES, spans):
        fade = 1 - (1 - dim) * _ease((frame - f0) / (f1 - f0))
        cooling = np.where(on < ps["frames"][0], cooling * fade, cooling)
    h = np.maximum(cooling, np.exp(-np.maximum(frame - on, 0) / 5.0))
    h = np.where(on <= frame, np.maximum(h, 0.2), 0.0)
    return np.maximum(h, to_timeline(len(on), frame) * 0.8)


def _ease(u):
    u = np.clip(u, 0.0, 1.0)
    return u * u * (3 - 2 * u)


def to_timeline(n: int, frame: float) -> np.ndarray:
    start = 108.0 + 20.0 * np.arange(n) / max(n - 1, 1)
    return _ease((frame - start) / 14.0)


def to_calendar(n: int, frame: float) -> np.ndarray:
    start = 146.0 + 16.0 * np.arange(n) / max(n - 1, 1)
    return _ease((frame - start) / 14.0)


def timeline_slots(day: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    days = 366 if (YEAR % 4 == 0 and (YEAR % 100 != 0 or YEAR % 400 == 0)) else 365
    pitch_day = (HIST["x1"] - HIST["x0"]) / days
    pitch = pitch_day * (1 - HIST["gap"]) / HIST["sub"]
    first = np.searchsorted(day, day, side="left")
    j = np.arange(len(day)) - first
    x = HIST["x0"] + day * pitch_day + (j % HIST["sub"] + 0.5) * pitch
    y = HIST["y0"] + (j // HIST["sub"] + 0.5) * pitch
    return x, y


def monthly_harmonized(series_path: Path) -> tuple[int, np.ndarray]:
    m = json.loads(Path(series_path).read_text())["monthly"]
    v = np.array([a if a is not None else (b if b is not None else 0.0) for a, b in zip(m["viirs"], m["pred"])], dtype=float)
    return int(m["start_year"]), v


def shares(values: np.ndarray, n: int) -> np.ndarray:
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
    order = np.lexsort((np.arctan2(jj, ii).ravel(), ring))
    ox, oy = ii.ravel()[order] * pitch, jj.ravel()[order] * pitch
    cell = np.repeat(np.arange(cells), count)
    slot = np.arange(n) - np.repeat(np.cumsum(count) - count, count)
    year, month = cell // GRID["months"], cell % GRID["months"]
    x = (year - (GRID["years"] - 1) / 2) * GRID["pitch"] + ox[slot]
    y = ((GRID["months"] - 1) / 2 - month) * GRID["pitch"] + oy[slot]
    return x, y, cell


def squares(p: dict, ground_z: np.ndarray, on: np.ndarray, slots_t, slots_c, frame: float):
    n = len(on)
    u, v = to_timeline(n, frame), to_calendar(n, frame)
    lift = np.where(p["modis"], 0.02, np.where(on >= PASSES[0]["frames"][0], 0.058, 0.05))
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


FIRE = (-13.6, -1.1)
EYE = (-4.55, -10.05)

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


ORBIT = {"in": (39.0, 45.0), "out": (67.0, 72.0), "elevation": 50.0, "bearing": (135.0, 195.0), "turn": (44.0, 72.0),
         "aim": 0.1}


def orbit_weight(frame: float) -> float:
    (a0, a1), (b0, b1) = ORBIT["in"], ORBIT["out"]
    return float(_ease((frame - a0) / (a1 - a0)) * _ease((b1 - frame) / (b1 - b0)))


def camera(dem: np.ndarray, frame: float) -> dict:
    keys = np.array(CAMERA, dtype=float)
    k = _spline(keys[:, 0], keys[:, 1:], frame)
    ex, ey, eh, tx, ty, th, mm, ground = k
    ground = float(np.clip(ground, 0, 1))
    logh = _spline(keys[:, 0], np.log(keys[:, 3:4]), frame)[0]
    eh = float(np.exp(logh))
    ez = eh + ground * float(height_km(dem, ex, ey))
    tz = max(th, 0.0) + ground * float(height_km(dem, tx, ty))
    w = float(_ease((frame - 30.0) / 24.0))
    up = np.array([0.0, w, 1.0 - w])

    o = orbit_weight(frame)
    if o > 0:
        d = np.array([ex - tx, ey - ty, ez - tz])
        dist = float(np.linalg.norm(d))
        el0 = math.atan2(d[2], math.hypot(d[0], d[1]))
        b0, b1 = ORBIT["bearing"]
        u0, u1 = ORBIT["turn"]
        az = math.radians(b0 + (b1 - b0) * float(_ease((frame - u0) / (u1 - u0))))
        az0 = math.atan2(d[0], d[1])
        az0 = az + (az0 - az + math.pi) % (2 * math.pi) - math.pi
        el = el0 + o * (math.radians(ORBIT["elevation"]) - el0)
        az = az0 + o * (az - az0)
        ex, ey, ez = tx + dist * math.cos(el) * math.sin(az), ty + dist * math.cos(el) * math.cos(az), tz + dist * math.sin(el)
        level = np.array([-math.sin(az), -math.cos(az), 0.0])
        up = up * (1 - o) + level * o
        tz += o * ORBIT["aim"] * dist
    up = up / np.linalg.norm(up)
    return {"eye": (float(ex), float(ey), float(ez)), "target": (float(tx), float(ty), float(tz)), "mm": float(mm),
            "up": tuple(float(v) for v in up)}


def viewpoint(dem: np.ndarray, p: dict, until: float, near: float = 7.0, far: float = 13.0, step: float = 0.45):
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
