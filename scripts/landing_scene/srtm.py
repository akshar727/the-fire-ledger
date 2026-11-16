import struct
import urllib.request
import zlib
from pathlib import Path

import numpy as np

URL = "https://opentopography.s3.sdsc.edu/raster/SRTM_GL3/SRTM_GL3_srtm/North/North_30_60/{name}.tif"
SIZE = 1201
NODATA = -32768

LAT0, LAT1 = 39, 41
LON0, LON1 = -9, -7


def tile_name(lat: int, lon: int) -> str:
    return f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}{'E' if lon >= 0 else 'W'}{abs(lon):03d}"


def fetch(name: str, folder: Path) -> Path:
    path = folder / f"{name}.tif"
    if not path.exists():
        folder.mkdir(parents=True, exist_ok=True)
        part = path.with_suffix(".part")
        with urllib.request.urlopen(URL.format(name=name), timeout=120) as r, open(part, "wb") as f:
            f.write(r.read())
        part.replace(path)
    return path


_TYPE = {3: "H", 4: "I", 16: "Q"}


def read_tile(path: Path) -> np.ndarray:
    data = Path(path).read_bytes()
    if data[:4] != b"II*\x00":
        raise ValueError(f"{path}: not a little-endian classic TIFF")
    (ifd,) = struct.unpack_from("<I", data, 4)
    (n,) = struct.unpack_from("<H", data, ifd)
    tags: dict[int, list[int]] = {}
    for k in range(n):
        tag, typ, count = struct.unpack_from("<HHI", data, ifd + 2 + 12 * k)
        if typ not in _TYPE:
            continue
        fmt = f"<{count}{_TYPE[typ]}"
        size = struct.calcsize(fmt)
        at = ifd + 2 + 12 * k + 8
        if size > 4:
            (at,) = struct.unpack_from("<I", data, at)
        tags[tag] = list(struct.unpack_from(fmt, data, at))
    need = {256: "width", 257: "height", 258: "bits", 259: "compression", 322: "tile width", 323: "tile height",
            324: "tile offsets", 325: "tile byte counts"}
    for tag, what in need.items():
        if tag not in tags:
            raise ValueError(f"{path}: TIFF has no {what} (tag {tag})")
    w, h, tw, th = tags[256][0], tags[257][0], tags[322][0], tags[323][0]
    if tags[258][0] != 16 or tags[259][0] not in (8, 32946) or tags.get(317, [1])[0] != 1 or tags.get(339, [1])[0] != 2:
        raise ValueError(f"{path}: expected 16-bit signed, deflate, no predictor")
    out = np.empty((h, w), dtype=np.int16)
    across = -(-w // tw)
    for i, (off, size) in enumerate(zip(tags[324], tags[325])):
        block = np.frombuffer(zlib.decompress(data[off:off + size]), dtype="<i2").reshape(th, tw)
        r, c = (i // across) * th, (i % across) * tw
        out[r:r + th, c:c + tw] = block[: h - r, : w - c]
    return out


def mosaic(folder: Path, download: bool = True) -> np.ndarray:
    rows, cols = (LAT1 - LAT0) * (SIZE - 1) + 1, (LON1 - LON0) * (SIZE - 1) + 1
    out = np.zeros((rows, cols), dtype=np.float32)
    for lat in range(LAT0, LAT1):
        for lon in range(LON0, LON1):
            name = tile_name(lat, lon)
            path = fetch(name, folder) if download else folder / f"{name}.tif"
            t = read_tile(path)
            if t.shape != (SIZE, SIZE):
                raise ValueError(f"{path}: {t.shape}, expected {SIZE} x {SIZE}")
            r, c = (LAT1 - 1 - lat) * (SIZE - 1), (lon - LON0) * (SIZE - 1)
            out[r:r + SIZE, c:c + SIZE] = np.where(t == NODATA, 0, t)
    return np.maximum(out, 0)
