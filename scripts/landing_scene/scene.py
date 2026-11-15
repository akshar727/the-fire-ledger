"""Builds and renders the landing-page scene (FE-019) in Blender, from our own data.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/landing_scene/scene.py -- --all
    blender -b --factory-startup -P scripts/landing_scene/scene.py -- --frames 0,36,72 --scale 50 --out /tmp/preview
    blender --factory-startup -P scripts/landing_scene/scene.py   # opens the scene; scrub frames 0-359 in the timeline

What is in it, and where it comes from:
  terrain   NASA SRTM GL3 elevation of central Portugal, 39-41 N, 9-7 W (srtm.py), heights x 2.5
  squares   every 2017 detection in that area from site/public/data/portugal/points/2017.csv, at its position, drawn
            at the sensor's nominal pixel size (MODIS 1 km, VIIRS 375 m), switched on in time order
  timeline  the same squares stacked by day of 2017
  calendar  the same number of squares dealt over 26 x 12 cells in proportion to the harmonized monthly record in
            site/public/data/portugal/series.json
  trees, grass, smoke, satellites, sky, sun: drawn by this script (no imported models, textures or images)

All positions and timings are computed in layout.py (plain numpy, tested without Blender); this file only draws.
Written for Blender 5.3 (EEVEE). Output: <out>/f000.webp ... f359.webp, 1600 x 900. Frame numbers are rendered
frames; apply() turns each into story time (layout.story_time), which every key in this file uses.
"""
import argparse
import math
import sys
import time
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import layout as L  # noqa: E402
import srtm  # noqa: E402

STEP = 2  # terrain mesh uses every 2nd SRTM sample (~180 m)
RNG = np.random.default_rng(2017)


# ---------------------------------------------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------------------------------------------

def smooth(u):
    u = min(1.0, max(0.0, u))
    return u * u * (3 - 2 * u)


def ramp(frame, keys):
    """Linear interpolation through (frame, value) keys."""
    return float(np.interp(frame, [k[0] for k in keys], [k[1] for k in keys]))


def new_mesh(name, co, faces, smooth_shading=True):
    """Mesh from an (n, 3) vertex array and an (m, k) face array (k = 3 or 4)."""
    me = bpy.data.meshes.new(name)
    faces = np.asarray(faces, dtype=np.int32)
    k = faces.shape[1]
    me.vertices.add(len(co))
    me.vertices.foreach_set("co", np.asarray(co, dtype=np.float32).ravel())
    me.loops.add(faces.size)
    me.loops.foreach_set("vertex_index", faces.ravel())
    me.polygons.add(len(faces))
    me.polygons.foreach_set("loop_start", np.arange(0, faces.size, k, dtype=np.int32))
    try:
        me.polygons.foreach_set("loop_total", np.full(len(faces), k, dtype=np.int32))
    except Exception:  # read-only since Blender 4.0: sizes follow from loop_start
        pass
    me.update(calc_edges=True)
    if smooth_shading:
        me.polygons.foreach_set("use_smooth", np.ones(len(faces), dtype=bool))
    return me


def add_object(name, data, material=None):
    ob = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(ob)
    if material is not None and hasattr(data, "materials"):
        data.materials.append(material)
    return ob


def float_attr(me, name, values):
    a = me.attributes.get(name) or me.attributes.new(name, "FLOAT", "POINT")
    a.data.foreach_set("value", np.asarray(values, dtype=np.float32))


def box_blur(a, r, axis):
    c = np.cumsum(np.pad(a, [(r + 1, r) if ax == axis else (0, 0) for ax in range(a.ndim)], mode="edge"), axis=axis, dtype=np.float64)
    n = a.shape[axis]
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def blur(a, r):
    """Three box blurs each way: close to a Gaussian."""
    for _ in range(3):
        a = box_blur(box_blur(a, r, 0), r, 1)
    return a


class Nodes:
    """Tiny wrapper to build a node tree without repeating boilerplate."""

    def __init__(self, tree):
        self.tree = tree
        tree.nodes.clear()

    def new(self, kind, **props):
        n = self.tree.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def link(self, a, b):
        self.tree.links.new(a, b)

    def math(self, op, a, b=None, clamp=False):
        n = self.new("ShaderNodeMath", operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                self.link(v, n.inputs[i])
        return n.outputs[0]

    def attr(self, name):
        return self.new("ShaderNodeAttribute", attribute_name=name).outputs["Fac"]

    def color_ramp(self, fac, stops):
        n = self.new("ShaderNodeValToRGB")
        els = n.color_ramp.elements
        while len(els) < len(stops):
            els.new(0.5)
        for e, (pos, col) in zip(els, stops):
            e.position, e.color = pos, (*col, 1.0)
        self.link(fac, n.inputs[0])
        return n.outputs["Color"]


def material(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    return m, Nodes(m.node_tree)


# ---------------------------------------------------------------------------------------------------------------
# terrain
# ---------------------------------------------------------------------------------------------------------------

def build_terrain(dem):
    d = dem[::STEP, ::STEP]
    rows, cols = d.shape
    lat = srtm.LAT1 - np.arange(rows) * STEP / (srtm.SIZE - 1)
    lon = srtm.LON0 + np.arange(cols) * STEP / (srtm.SIZE - 1)
    x, y = L.project(lat[:, None], lon[None, :])
    x, y = np.broadcast_to(x, d.shape), np.broadcast_to(y, d.shape)
    co = np.stack([x, y, d / 1000.0 * L.EXAG], axis=-1).reshape(-1, 3)
    me = new_mesh("Terrain", co, L.mesh_faces(rows, cols))  # triangles, so layout.surface_km is its exact height

    # how far inside the tiles a vertex is (0 at the edge): the land fades into the dark instead of ending in a cliff
    ex = np.minimum(np.arange(cols), np.arange(cols)[::-1])[None, :] / cols
    ey = np.minimum(np.arange(rows), np.arange(rows)[::-1])[:, None] / rows
    edge = np.clip(np.minimum(ex, ey) / 0.12, 0, 1)
    float_attr(me, "fade", (edge * edge * (3 - 2 * edge) * np.ones_like(d)).ravel())
    float_attr(me, "sea", (d <= 0).astype(np.float32).ravel())
    float_attr(me, "glow", np.zeros(d.size))

    mat, n = material("Terrain")
    out = n.new("ShaderNodeOutputMaterial")
    bsdf = n.new("ShaderNodeBsdfPrincipled")
    geo = n.new("ShaderNodeNewGeometry")
    pos = n.new("ShaderNodeSeparateXYZ")
    n.link(geo.outputs["Position"], pos.inputs[0])
    nor = n.new("ShaderNodeSeparateXYZ")
    n.link(geo.outputs["Normal"], nor.inputs[0])
    noise = n.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 1.6
    noise.inputs["Detail"].default_value = 6.0
    height = n.math("ADD", n.math("DIVIDE", pos.outputs["Z"], 2.0 * L.EXAG), n.math("MULTIPLY", noise.outputs["Fac"], 0.12))
    land = n.color_ramp(height, [
        (0.0, (0.070, 0.085, 0.050)), (0.18, (0.045, 0.070, 0.036)), (0.42, (0.085, 0.092, 0.052)),
        (0.7, (0.16, 0.14, 0.10)), (1.0, (0.27, 0.25, 0.23)),
    ])
    steep = n.math("SUBTRACT", 1.0, nor.outputs["Z"], clamp=True)  # 0 flat .. 1 vertical
    rock = n.new("ShaderNodeMixRGB", blend_type="MIX")
    n.link(n.math("MULTIPLY", steep, 2.2, clamp=True), rock.inputs["Fac"])
    n.link(land, rock.inputs["Color1"])
    rock.inputs["Color2"].default_value = (0.11, 0.10, 0.09, 1)
    sea = n.new("ShaderNodeMixRGB", blend_type="MIX")
    n.link(n.attr("sea"), sea.inputs["Fac"])
    n.link(rock.outputs["Color"], sea.inputs["Color1"])
    sea.inputs["Color2"].default_value = (0.004, 0.008, 0.016, 1)
    faded = n.new("ShaderNodeMixRGB", blend_type="MULTIPLY")
    faded.inputs["Fac"].default_value = 1.0
    n.link(sea.outputs["Color"], faded.inputs["Color1"])
    fade = n.new("ShaderNodeAttribute", attribute_name="fade")
    n.link(fade.outputs["Color"], faded.inputs["Color2"])
    n.link(faded.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.92
    n.link(n.math("MULTIPLY", n.attr("sea"), 0.25), bsdf.inputs["Specular IOR Level"])
    # fire light on the ground around the squares
    glow = n.color_ramp(n.attr("glow"), [(0.0, (0, 0, 0)), (0.25, (0.55, 0.06, 0.0)), (0.7, (1.0, 0.33, 0.03)), (1.0, (1.0, 0.75, 0.3))])
    n.link(glow, bsdf.inputs["Emission Color"])
    strength = n.new("ShaderNodeValue", label="glow strength", name="glow_strength")
    strength.outputs[0].default_value = 1.0
    n.link(n.math("MULTIPLY", n.math("MULTIPLY", n.attr("glow"), strength.outputs[0]), n.attr("fade")), bsdf.inputs["Emission Strength"])
    n.link(bsdf.outputs["BSDF"], out.inputs["Surface"])
    ob = add_object("Terrain", me, mat)
    return ob, d.shape


def ground_glow(S, pos, size, heat, on_ground):
    """Fire light on the terrain: the squares' heat splatted onto the terrain grid and blurred."""
    rows, cols = S["grid"]
    g = np.zeros((rows, cols), dtype=np.float32)
    sel = on_ground & (heat > 0)
    if sel.any():
        per = (srtm.SIZE - 1) / STEP
        c = np.clip(np.rint((pos[sel, 0] / L.KM_LON + L.LON_C - srtm.LON0) * per).astype(int), 0, cols - 1)
        r = np.clip(np.rint((srtm.LAT1 - (pos[sel, 1] / L.KM_LAT + L.LAT_C)) * per).astype(int), 0, rows - 1)
        np.add.at(g, (r, c), heat[sel] * size[sel] ** 2 * 26.0)
        g = blur(g, 3)
    return np.clip(g, 0, 1)


# ---------------------------------------------------------------------------------------------------------------
# squares (the detections)
# ---------------------------------------------------------------------------------------------------------------

# A square seen from above, a low tent seen from the side (so fire lines read on a slope from the ground).
TENT = np.array([[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0], [0, 0, 0.2]], dtype=np.float32)
TENT_FACES = np.array([[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]], dtype=np.int32)


def build_squares(p):
    n = len(p["t"])
    faces = (TENT_FACES[None, :, :] + (np.arange(n) * 5)[:, None, None]).reshape(-1, 3)
    me = new_mesh("Detections", np.zeros((n * 5, 3), dtype=np.float32), faces, smooth_shading=False)
    float_attr(me, "heat", np.zeros(n * 5))
    float_attr(me, "modis", np.repeat(p["modis"].astype(np.float32), 5))
    mat, nd = material("Detection")
    out = nd.new("ShaderNodeOutputMaterial")
    em = nd.new("ShaderNodeEmission")
    heat = nd.attr("heat")
    viirs = nd.color_ramp(heat, [(0.0, (0.10, 0.004, 0.0)), (0.12, (0.42, 0.03, 0.0)), (0.5, (0.95, 0.20, 0.012)), (1.0, (1.0, 0.46, 0.07))])
    modis = nd.color_ramp(heat, [(0.0, (0.08, 0.0, 0.0)), (0.12, (0.30, 0.012, 0.0)), (0.5, (0.62, 0.05, 0.006)), (1.0, (0.90, 0.11, 0.015))])
    mix = nd.new("ShaderNodeMixRGB", blend_type="MIX")
    nd.link(nd.attr("modis"), mix.inputs["Fac"])
    nd.link(viirs, mix.inputs["Color1"])
    nd.link(modis, mix.inputs["Color2"])
    nd.link(mix.outputs["Color"], em.inputs["Color"])
    gain = nd.new("ShaderNodeValue", label="gain", name="gain")
    gain.outputs[0].default_value = 1.0
    hot = nd.math("ADD", nd.math("MULTIPLY", nd.math("POWER", heat, 2.0), 1.7), 0.5)
    nd.link(nd.math("MULTIPLY", hot, gain.outputs[0]), em.inputs["Strength"])
    nd.link(em.outputs["Emission"], out.inputs["Surface"])
    ob = add_object("Detections", me, mat)
    ob.visible_shadow = False
    return ob


def update_squares(S, pos, size, heat):
    co = pos[:, None, :] + TENT[None, :, :] * np.where(heat > 0, size, 0.0)[:, None, None]
    me = S["squares"].data
    me.vertices.foreach_set("co", co.astype(np.float32).ravel())
    float_attr(me, "heat", np.repeat(heat, 5))
    me.update()


# ---------------------------------------------------------------------------------------------------------------
# forest around the opening viewpoint
# ---------------------------------------------------------------------------------------------------------------

def pine(height, seed):
    """A maritime pine as a few cones on a tapering trunk: (verts, faces), base at the origin, km."""
    r = np.random.default_rng(seed)
    sides = 7
    ang = np.linspace(0, 2 * np.pi, sides, endpoint=False)
    verts, faces = [], []

    def cone(z0, z1, r0, lean):
        base = len(verts)
        for a in ang:
            verts.append((r0 * math.cos(a) + lean[0], r0 * math.sin(a) + lean[1], z0))
        verts.append((lean[0], lean[1], z1))
        for k in range(sides):
            faces.append((base + k, base + (k + 1) % sides, base + sides))

    trunk_r = height * 0.009
    base = len(verts)
    for z, rr in ((0.0, trunk_r), (height * 0.62, trunk_r * 0.6)):
        for a in ang:
            verts.append((rr * math.cos(a), rr * math.sin(a), z))
    for k in range(sides):
        a, b = base + k, base + (k + 1) % sides
        faces.append((a, b, b + sides))
        faces.append((a, b + sides, a + sides))
    z = height * 0.45
    for tier in range(6):
        w = height * (0.17 - 0.024 * tier) * r.uniform(0.8, 1.2)
        top = z + height * r.uniform(0.15, 0.2)
        cone(z, top, w, r.normal(0, height * 0.015, 2))
        z += height * 0.085
    return np.array(verts, dtype=np.float32), np.array(faces, dtype=np.int32)


def far_pine(seed):
    """A pine for the distant hills: two cones and no trunk (seen from a kilometre or more), base at the origin."""
    r = np.random.default_rng(seed)
    sides = 5
    ang = np.linspace(0, 2 * np.pi, sides, endpoint=False) + r.uniform(0, 1)
    verts, faces = [], []
    for z0, z1, w in ((0.22, 0.78, 0.21), (0.52, 1.0, 0.14)):
        base = len(verts)
        lean = r.normal(0, 0.02, 2)
        verts += [(w * r.uniform(0.85, 1.15) * math.cos(a) + lean[0], w * math.sin(a) + lean[1], z0) for a in ang]
        verts.append((lean[0], lean[1], z1))
        faces += [(base + k, base + (k + 1) % sides, base + sides) for k in range(sides)]
    return np.array(verts, dtype=np.float32), np.array(faces, dtype=np.int32)


def plant(variants, x, y, z, h):
    """
    Copies of the variant meshes at x, y (base height z), scaled to height h and turned at random: (vertices,
    faces, tree index of each vertex, height of each vertex up its tree 0..1), in tree order.
    """
    which = RNG.integers(0, len(variants), len(x))
    rot = RNG.uniform(0, 2 * np.pi, len(x))
    cos, faces, owner, up, base = [], [], [], [], 0
    for k, (v, f) in enumerate(variants):
        sel = np.where(which == k)[0]
        c, s = np.cos(rot[sel])[:, None], np.sin(rot[sel])[:, None]
        vx = (v[None, :, 0] * c - v[None, :, 1] * s) * h[sel, None] + x[sel, None]
        vy = (v[None, :, 0] * s + v[None, :, 1] * c) * h[sel, None] + y[sel, None]
        vz = v[None, :, 2] * h[sel, None] + z[sel, None] - 0.0015 * h[sel, None] / 0.03
        cos.append(np.stack([vx, vy, vz], axis=-1).reshape(-1, 3))
        faces.append((f[None, :, :] + (np.arange(len(sel)) * len(v))[:, None, None] + base).reshape(-1, 3))
        owner.append(np.repeat(sel, len(v)))
        up.append(np.tile(v[:, 2] / v[:, 2].max(), len(sel)))
        base += len(sel) * len(v)
    return np.concatenate(cos), np.concatenate(faces), np.concatenate(owner), np.concatenate(up)


def tree_material():
    """Pine needles in the evening sun and the night: dark green, varied per tree, lit orange from below near fire."""
    mat, nd = material("Pine")
    out = nd.new("ShaderNodeOutputMaterial")
    bsdf = nd.new("ShaderNodeBsdfPrincipled")
    color = nd.color_ramp(nd.attr("tone"), [(0.0, (0.030, 0.048, 0.022)), (0.6, (0.050, 0.068, 0.030)), (1.0, (0.085, 0.080, 0.040))])
    shade = nd.new("ShaderNodeMixRGB", blend_type="MULTIPLY")
    shade.inputs["Fac"].default_value = 1.0
    nd.link(color, shade.inputs["Color1"])
    lift = nd.math("ADD", nd.math("MULTIPLY", nd.attr("up"), 0.55), 0.45)  # darker inside, low in the crown
    comb = nd.new("ShaderNodeCombineXYZ")
    for k in range(3):
        nd.link(lift, comb.inputs[k])
    nd.link(comb.outputs[0], shade.inputs["Color2"])
    nd.link(shade.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Specular IOR Level"].default_value = 0.1
    glow = nd.color_ramp(nd.attr("glow"), [(0.0, (0, 0, 0)), (0.25, (0.6, 0.08, 0.0)), (1.0, (1.0, 0.45, 0.08))])
    nd.link(glow, bsdf.inputs["Emission Color"])
    strength = nd.new("ShaderNodeValue", label="glow strength", name="glow_strength")
    strength.outputs[0].default_value = 1.0
    low = nd.math("POWER", nd.math("SUBTRACT", 1.0, nd.attr("up"), clamp=True), 2.0)
    nd.link(nd.math("MULTIPLY", nd.math("MULTIPLY", nd.attr("glow"), low), strength.outputs[0]), bsdf.inputs["Emission Strength"])
    nd.link(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def tree_object(name, variants, x, y, z, h, mat):
    co, faces, owner, up = plant(variants, x, y, z, h)
    me = new_mesh(name, co, faces, smooth_shading=False)
    float_attr(me, "tone", RNG.uniform(0, 1, len(x))[owner])
    float_attr(me, "up", up)
    float_attr(me, "glow", np.zeros(len(co)))
    return add_object(name, me, mat), owner


def clear_view(x, y, top, eye, targets, bin_deg=0.2, margin=0.0015):
    """
    False for every tree whose top would stand in front of a burning square seen from `eye` (the opening viewpoint),
    so the forest frames the fire instead of hiding it. Only squares the terrain itself leaves in view count.
    """
    ex, ey, ez = eye
    tx, ty, tz = targets
    s = np.linspace(0.02, 0.98, 48)[None, :]
    seen = np.all(L.surface_km(DEM[0], ex + (tx[:, None] - ex) * s, ey + (ty[:, None] - ey) * s)
                  < ez + (tz[:, None] - ez) * s, axis=1)
    tx, ty, tz = tx[seen], ty[seen], tz[seen]
    nb = int(round(360 / bin_deg))
    bins = lambda ax, ay: (((np.degrees(np.arctan2(ay - ey, ax - ex)) + 180) / bin_deg).astype(int)) % nb  # noqa: E731
    dt = np.hypot(tx - ex, ty - ey)
    lowest, far = np.full(nb, np.inf), np.zeros(nb)
    np.minimum.at(lowest, bins(tx, ty), (tz - ez) / dt)
    np.maximum.at(far, bins(tx, ty), dt)
    for _ in range(2):  # a bin either side
        lowest = np.minimum(lowest, np.minimum(np.roll(lowest, 1), np.roll(lowest, -1)))
        far = np.maximum(far, np.maximum(np.roll(far, 1), np.roll(far, -1)))
    b, d = bins(x, y), np.hypot(x - ex, y - ey)
    return ~((d < far[b]) & ((top - ez) / d > lowest[b] - margin))


DEM = []  # the elevation grid, for clear_view (set in build)


def build_forest(dem, eye, targets, mat):
    """Detailed pines around the opening viewpoint, denser close to it, with a view to the fire left open."""
    ex, ey = L.EYE
    n = 16000
    rad = 1.6 * np.sqrt(RNG.uniform(0, 1, n)) ** 1.6 + 0.004  # denser near the eye
    ang = RNG.uniform(0, 2 * np.pi, n)
    x, y = ex + rad * np.cos(ang), ey + rad * np.sin(ang)
    h = RNG.uniform(0.016, 0.030, n) * 1.25
    z = L.surface_km(dem, x, y)
    to_fire = np.array(L.FIRE) - np.array(L.EYE)
    to_fire /= np.linalg.norm(to_fire)
    along = (x - ex) * to_fire[0] + (y - ey) * to_fire[1]
    across = np.abs(-(x - ex) * to_fire[1] + (y - ey) * to_fire[0])
    keep = ~((along > 0) & (along < 0.35) & (across < 0.012 + along * 0.22))  # a clearing towards the fire
    keep &= (rad > 0.014) & clear_view(x, y, z + h, eye, targets)
    variants = [pine(1.0, s) for s in range(6)]
    ob, _ = tree_object("Forest", variants, x[keep], y[keep], z[keep], h[keep], mat)
    return ob


def build_far_forest(dem, eye, targets, mat, grid):
    """
    Pines over the hills between the opening viewpoint and the fire and all around the fire, in patches, thinning
    on steep slopes and above 1,100 m. Returns the object and, per vertex, the terrain-grid cell under its tree (the
    fire light on the ground is copied onto the trees each frame).
    """
    ex, ey, _ = eye
    fx, fy = L.FIRE
    d = np.array([fx - ex, fy - ey])
    length = float(np.linalg.norm(d))
    d /= length
    n = 1_400_000
    x = RNG.uniform(min(ex, fx) - 9.0, max(ex, fx) + 9.0, n)
    y = RNG.uniform(min(ey, fy) - 9.0, max(ey, fy) + 9.0, n)
    along = (x - ex) * d[0] + (y - ey) * d[1]
    across = np.abs(-(x - ex) * d[1] + (y - ey) * d[0])
    keep = (along > -2.5) & (along < length + 7.0) & (across < 8.0) & (np.hypot(x - ex, y - ey) > 1.2)
    x, y = x[keep], y[keep]
    z = L.surface_km(dem, x, y)
    # patches: a smooth random field on a 250 m lattice
    x0, y0, cell = x.min(), y.min(), 0.25
    field = blur(RNG.normal(size=(int((y.max() - y0) / cell) + 2, int((x.max() - x0) / cell) + 2)).astype(np.float32), 3)
    field = (field - field.mean()) / field.std()
    f = field[((y - y0) / cell).astype(int), ((x - x0) / cell).astype(int)]
    gx = (L.surface_km(dem, x + 0.06, y) - L.surface_km(dem, x - 0.06, y)) / 0.12
    gy = (L.surface_km(dem, x, y + 0.06) - L.surface_km(dem, x, y - 0.06)) / 0.12
    slope = np.hypot(gx, gy) / L.EXAG
    chance = np.clip((f + 0.6) / 1.4, 0, 1) * np.clip(1 - (slope - 0.35) / 0.3, 0, 1)
    chance *= (z > 0.05 * L.EXAG) & (z < 1.1 * L.EXAG)
    keep = RNG.uniform(0, 1, len(x)) < chance * 0.42
    x, y, z = x[keep], y[keep], z[keep]
    h = RNG.uniform(0.020, 0.036, len(x))
    keep = clear_view(x, y, z + h, eye, targets)
    x, y, z, h = x[keep], y[keep], z[keep], h[keep]
    ob, owner = tree_object("Far forest", [far_pine(s) for s in range(5)], x, y, z, h, mat)
    rows, cols = grid
    per = (srtm.SIZE - 1) / STEP
    c = np.clip(np.rint((x / L.KM_LON + L.LON_C - srtm.LON0) * per).astype(int), 0, cols - 1)
    r = np.clip(np.rint((srtm.LAT1 - (y / L.KM_LAT + L.LAT_C)) * per).astype(int), 0, rows - 1)
    print(f"far forest: {len(x)} pines")
    return ob, (r * cols + c)[owner]


def build_grass(dem, eye):
    """Grass blades in front of the opening viewpoint, dense close by: dry June grass with a little green left."""
    ex, ey, _ = eye
    face = math.atan2(L.FIRE[1] - ey, L.FIRE[0] - ex)
    n = 420_000
    ang = face + RNG.uniform(-0.95, 0.95, n)
    rad = 0.0008 + 0.11 * RNG.uniform(0, 1, n) ** 2.0
    x, y = ex + rad * np.cos(ang), ey + rad * np.sin(ang)
    z = L.surface_km(dem, x, y) - 0.00005
    clump = 0.55 + 0.9 * np.clip(blur(RNG.uniform(0, 1, (64, 64)).astype(np.float32), 2) * 2.2 - 0.6, 0, 1)
    gi = np.clip(((rad * np.cos(ang - face)) / 0.111 * 63).astype(int), 0, 63)
    gj = np.clip(((rad * np.sin(ang - face)) / 0.111 * 32 + 32).astype(int), 0, 63)
    h = RNG.uniform(0.00022, 0.00065, n) * clump[gi, gj]
    w = RNG.uniform(0.000012, 0.000026, n)
    phi = RNG.uniform(0, 2 * np.pi, n)
    px, py = np.cos(phi) * w / 2, np.sin(phi) * w / 2
    lean = RNG.uniform(0.08, 0.45, n) * h
    lx = np.cos(phi + np.pi / 2) * lean * 0.6 + lean * 0.4 * 0.7  # partly random, partly a breeze to the east
    ly = np.sin(phi + np.pi / 2) * lean * 0.6 + lean * 0.4 * 0.3
    # five points per blade: base pair, a narrower pair half-way (bent less), the tip
    co = np.stack([
        np.stack([x - px, y - py, z], -1), np.stack([x + px, y + py, z], -1),
        np.stack([x - px * 0.6 + lx * 0.3, y - py * 0.6 + ly * 0.3, z + h * 0.55], -1),
        np.stack([x + px * 0.6 + lx * 0.3, y + py * 0.6 + ly * 0.3, z + h * 0.55], -1),
        np.stack([x + lx, y + ly, z + h], -1),
    ], axis=1).reshape(-1, 3)
    f = np.array([[0, 1, 3], [0, 3, 2], [2, 3, 4]], dtype=np.int32)
    faces = (f[None, :, :] + (np.arange(n) * 5)[:, None, None]).reshape(-1, 3)
    me = new_mesh("Grass", co, faces, smooth_shading=False)
    float_attr(me, "tone", np.repeat(RNG.beta(2.2, 1.6, n), 5))
    float_attr(me, "tip", np.tile(np.array([0, 0, 0.55, 0.55, 1.0], dtype=np.float32), n))
    mat, nd = material("Grass")
    out = nd.new("ShaderNodeOutputMaterial")
    bsdf = nd.new("ShaderNodeBsdfPrincipled")
    color = nd.color_ramp(nd.attr("tone"), [(0.0, (0.045, 0.075, 0.020)), (0.45, (0.12, 0.12, 0.035)), (1.0, (0.30, 0.22, 0.08))])
    shade = nd.new("ShaderNodeMixRGB", blend_type="MULTIPLY")
    shade.inputs["Fac"].default_value = 1.0
    nd.link(color, shade.inputs["Color1"])
    lift = nd.math("ADD", nd.math("MULTIPLY", nd.attr("tip"), 0.65), 0.35)
    comb = nd.new("ShaderNodeCombineXYZ")
    for k in range(3):
        nd.link(lift, comb.inputs[k])
    nd.link(comb.outputs[0], shade.inputs["Color2"])
    nd.link(shade.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.75
    trans = nd.new("ShaderNodeBsdfTranslucent")  # low sun through the blades
    nd.link(shade.outputs["Color"], trans.inputs["Color"])
    mix = nd.new("ShaderNodeMixShader")
    mix.inputs["Fac"].default_value = 0.3
    nd.link(bsdf.outputs["BSDF"], mix.inputs[1])
    nd.link(trans.outputs["BSDF"], mix.inputs[2])
    nd.link(mix.outputs["Shader"], out.inputs["Surface"])
    return add_object("Grass", me, mat)


# ---------------------------------------------------------------------------------------------------------------
# sky, light, smoke
# ---------------------------------------------------------------------------------------------------------------

SUN_AZ = 300.0  # sunset on 17 June at 40 N is about 300 degrees (west-north-west): behind the fire from the eye


def sun_vector(t):
    """Unit vector towards the sun at story time t: low in the west-north-west, setting by t = 27."""
    el = math.radians(ramp(t, [(0, 12.0), (10, 8.0), (18, 4.0), (24, 1.0), (30, -3.0), (40, -8.0)]))
    az = math.radians(SUN_AZ)
    return Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))


def build_world():
    """
    The sky, from the end of the afternoon of 17 June to the night: a blue day sky with the sun low behind the fire,
    a warm glow on the horizon around the sun as it sets, then the night sky (lighter than black, so the hills and
    trees still read against it). Values `day`, `glow`, `sun` and `sky` are keyed per frame in apply().
    """
    w = bpy.data.worlds.new("Evening and night of 17 June")
    w.use_nodes = True
    n = Nodes(w.node_tree)
    out = n.new("ShaderNodeOutputWorld")
    bg = n.new("ShaderNodeBackground")
    tc = n.new("ShaderNodeTexCoord")
    xyz = n.new("ShaderNodeSeparateXYZ")
    n.link(tc.outputs["Generated"], xyz.inputs[0])
    up = n.math("ABSOLUTE", xyz.outputs["Z"])
    night = n.color_ramp(up, [(0.0, (0.085, 0.100, 0.165)), (0.12, (0.034, 0.046, 0.095)), (0.5, (0.010, 0.015, 0.042)), (1.0, (0.004, 0.006, 0.018))])
    day = n.color_ramp(up, [(0.0, (0.78, 0.72, 0.62)), (0.05, (0.42, 0.58, 0.86)), (0.25, (0.15, 0.33, 0.78)), (1.0, (0.05, 0.16, 0.55))])
    sky = n.new("ShaderNodeMixRGB", blend_type="MIX")
    daylight = n.new("ShaderNodeValue", label="day", name="day")
    daylight.outputs[0].default_value = 1.0
    n.link(daylight.outputs[0], sky.inputs["Fac"])
    n.link(night, sky.inputs["Color1"])
    n.link(day, sky.inputs["Color2"])
    # towards the sun: a wide warm glow low on the horizon, a tighter bright halo, and the disc itself
    to_sun = n.new("ShaderNodeVectorMath", operation="DOT_PRODUCT", name="to_sun")
    n.link(tc.outputs["Generated"], to_sun.inputs[0])
    to_sun.inputs[1].default_value = sun_vector(0)
    c = n.math("MAXIMUM", to_sun.outputs["Value"], 0.0)
    low = n.math("POWER", n.math("SUBTRACT", 1.0, up, clamp=True), 7.0)
    glow_amount = n.new("ShaderNodeValue", label="glow", name="glow")
    glow_amount.outputs[0].default_value = 1.0
    wide = n.math("MULTIPLY", n.math("MULTIPLY", n.math("POWER", c, 4.0), low), glow_amount.outputs[0])
    sun_amount = n.new("ShaderNodeValue", label="sun", name="sun")
    sun_amount.outputs[0].default_value = 1.0
    halo = n.math("MULTIPLY", n.math("ADD", n.math("MULTIPLY", n.math("POWER", c, 120.0), 1.5),
                                      n.math("MULTIPLY", n.math("POWER", c, 20000.0), 40.0)), sun_amount.outputs[0])
    add = n.new("ShaderNodeMixRGB", blend_type="ADD")
    n.link(wide, add.inputs["Fac"])
    n.link(sky.outputs["Color"], add.inputs["Color1"])
    add.inputs["Color2"].default_value = (1.0, 0.40, 0.13, 1)
    add2 = n.new("ShaderNodeMixRGB", blend_type="ADD")  # sky + halo x sun colour (halo can exceed 1: no clamping)
    add2.inputs["Fac"].default_value = 1.0
    n.link(add.outputs["Color"], add2.inputs["Color1"])
    sun_col = n.new("ShaderNodeMixRGB", blend_type="MULTIPLY", name="sun_colour")  # Color1 keyed in apply()
    sun_col.inputs["Fac"].default_value = 1.0
    comb = n.new("ShaderNodeCombineXYZ")
    for k in range(3):
        n.link(halo, comb.inputs[k])
    n.link(comb.outputs[0], sun_col.inputs["Color2"])
    n.link(sun_col.outputs["Color"], add2.inputs["Color2"])
    n.link(add2.outputs["Color"], bg.inputs["Color"])
    strength = n.new("ShaderNodeValue", label="sky", name="sky")
    strength.outputs[0].default_value = 1.0
    n.link(strength.outputs[0], bg.inputs["Strength"])
    n.link(bg.outputs["Background"], out.inputs["Surface"])
    bpy.context.scene.world = w
    return w


def build_lights():
    sky = bpy.data.lights.new("Sky light", "SUN")
    sky.color = (0.55, 0.66, 1.0)
    sky.angle = math.radians(8)
    ob = add_object("Sky light", sky)
    ob.rotation_euler = (math.radians(58), 0, math.radians(128))  # from the north-west, 32 degrees up
    sky.volume_factor = 0.2  # lights the land more than the smoke, so a lighter night does not turn the air to fog
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.angle = math.radians(1.2)
    sun.volume_factor = 0.3
    sun_ob = add_object("Sun", sun)
    fires = []
    for k in range(6):
        li = bpy.data.lights.new(f"Fire light {k}", "POINT")
        li.color = (1.0, 0.36, 0.08)
        li.shadow_soft_size = 0.6
        li.use_shadow = False
        fires.append(add_object(f"Fire light {k}", li))
    return ob, sun_ob, fires


def build_smoke():
    """Smoke over the June fire and a thin haze in the valleys: one volume box, density from position."""
    me = bpy.data.meshes.new("Air")
    x0, x1, y0, y1, z0, z1 = -85.0, 85.0, -110.0, 110.0, 0.0, 9.0
    co = [(x, y, z) for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)]
    me.from_pydata(co, [], [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)])
    mat, n = material("Smoke")
    out = n.new("ShaderNodeOutputMaterial")
    vol = n.new("ShaderNodeVolumePrincipled")
    geo = n.new("ShaderNodeNewGeometry")
    pos = n.new("ShaderNodeSeparateXYZ")
    n.link(geo.outputs["Position"], pos.inputs[0])
    # plume: rises from the fire and leans east-north-east with height
    lean_x = n.math("ADD", L.FIRE[0], n.math("MULTIPLY", pos.outputs["Z"], 2.2))
    lean_y = n.math("ADD", L.FIRE[1], n.math("MULTIPLY", pos.outputs["Z"], 0.8))
    dx = n.math("DIVIDE", n.math("SUBTRACT", pos.outputs["X"], lean_x), 14.0)
    dy = n.math("DIVIDE", n.math("SUBTRACT", pos.outputs["Y"], lean_y), 12.0)
    r2 = n.math("ADD", n.math("MULTIPLY", dx, dx), n.math("MULTIPLY", dy, dy))
    plume = n.math("EXPONENT", n.math("MULTIPLY", r2, -1.0))
    zz = n.math("DIVIDE", n.math("SUBTRACT", pos.outputs["Z"], 2.6), 1.7)
    layer = n.math("EXPONENT", n.math("MULTIPLY", n.math("MULTIPLY", zz, zz), -1.0))
    noise = n.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 0.22
    noise.inputs["Detail"].default_value = 5.0
    noise.inputs["Roughness"].default_value = 0.62
    n.link(geo.outputs["Position"], noise.inputs["Vector"])
    puff = n.math("MULTIPLY", n.math("SUBTRACT", noise.outputs["Fac"], 0.34, clamp=True), 3.0)
    smoke = n.math("MULTIPLY", n.math("MULTIPLY", plume, layer), puff)
    haze = n.math("MULTIPLY", n.math("EXPONENT", n.math("MULTIPLY", pos.outputs["Z"], -1.4)), 0.012)
    amount = n.new("ShaderNodeValue", label="smoke", name="smoke")
    amount.outputs[0].default_value = 1.0
    thin = n.new("ShaderNodeValue", label="haze", name="haze")
    thin.outputs[0].default_value = 1.0
    density = n.math("ADD", n.math("MULTIPLY", smoke, amount.outputs[0]), n.math("MULTIPLY", haze, thin.outputs[0]))
    n.link(density, vol.inputs["Density"])
    vol.inputs["Color"].default_value = (0.62, 0.60, 0.58, 1)
    vol.inputs["Anisotropy"].default_value = 0.35
    n.link(vol.outputs["Volume"], out.inputs["Volume"])
    ob = add_object("Air", me, mat)
    ob.display_type = "WIRE"
    return ob


# ---------------------------------------------------------------------------------------------------------------
# satellites and their scan lines
# ---------------------------------------------------------------------------------------------------------------

def box(cx, cy, cz, sx, sy, sz):
    v = np.array([[x, y, z] for z in (-0.5, 0.5) for y in (-0.5, 0.5) for x in (-0.5, 0.5)], dtype=np.float32)
    v = v * (sx, sy, sz) + (cx, cy, cz)
    f = np.array([(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)], dtype=np.int32)
    return v, f


def build_satellite(name, wings):
    """A plain satellite: a foil-wrapped bus, an instrument facing down, solar wings. No imported model."""
    def mat(label, color, metallic, rough, emit=0.0):
        m, n = material(f"{name} {label}")
        out = n.new("ShaderNodeOutputMaterial")
        b = n.new("ShaderNodeBsdfPrincipled")
        b.inputs["Base Color"].default_value = (*color, 1)
        b.inputs["Metallic"].default_value = metallic
        b.inputs["Roughness"].default_value = rough
        b.inputs["Emission Color"].default_value = (*color, 1)
        b.inputs["Emission Strength"].default_value = emit
        n.link(b.outputs["BSDF"], out.inputs["Surface"])
        return m

    parts = {
        "foil": ([box(0, 0, 0, 1.0, 1.6, 1.0), box(0, 0.2, -0.62, 0.5, 0.7, 0.3)], mat("foil", (0.80, 0.56, 0.20), 1.0, 0.38, 0.25)),
        "panel": ([box(sx * (0.5 + 0.25 + k * 1.02 + 0.5), 0, 0, 1.0, 1.5, 0.04) for sx in wings for k in range(3)],
                  mat("panel", (0.03, 0.06, 0.22), 0.6, 0.25, 0.5)),
        "frame": ([box(sx * (0.5 + 1.65), 0, 0, 3.3, 0.05, 0.07) for sx in wings] + [box(0, -0.95, 0.1, 0.12, 0.5, 0.12)],
                  mat("frame", (0.55, 0.56, 0.6), 1.0, 0.4, 0.15)),
    }
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    for label, (boxes, m) in parts.items():
        co = np.concatenate([b[0] for b in boxes])
        fa = np.concatenate([b[1] + 8 * k for k, b in enumerate(boxes)])
        ob = add_object(f"{name} {label}", new_mesh(f"{name} {label}", co, fa, smooth_shading=False), m)
        ob.parent = root
        ob.visible_shadow = False
    return root


def build_scan_line(name, color, width):
    v, f = box(0, 0, 0, 900.0, width, 0.02)
    m, n = material(name)
    out = n.new("ShaderNodeOutputMaterial")
    em = n.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*color, 1)
    em.inputs["Strength"].default_value = 2.5
    n.link(em.outputs["Emission"], out.inputs["Surface"])
    ob = add_object(name, new_mesh(name, v, f, smooth_shading=False), m)
    ob.visible_shadow = False
    return ob


# ---------------------------------------------------------------------------------------------------------------
# axis under the timeline
# ---------------------------------------------------------------------------------------------------------------

def build_axis():
    """A baseline under the daily columns with a tick at the first of each month."""
    boxes = [box(0, L.HIST["y0"] - 0.7, L.Z_PLANE, L.HIST["x1"] - L.HIST["x0"], 0.18, 0.02)]
    days = np.cumsum([0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
    for d in days:
        boxes.append(box(L.HIST["x0"] + (L.HIST["x1"] - L.HIST["x0"]) * d / 365, L.HIST["y0"] - 1.5, L.Z_PLANE, 0.18, 1.6, 0.02))
    co = np.concatenate([b[0] for b in boxes])
    fa = np.concatenate([b[1] + 8 * k for k, b in enumerate(boxes)])
    m, n = material("Axis")
    out = n.new("ShaderNodeOutputMaterial")
    em = n.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (0.75, 0.72, 0.68, 1)
    n.link(em.outputs["Emission"], out.inputs["Surface"])
    ob = add_object("Axis", new_mesh("Axis", co, fa, smooth_shading=False), m)
    ob.visible_shadow = False
    return ob, em


# ---------------------------------------------------------------------------------------------------------------
# the scene and the frame function
# ---------------------------------------------------------------------------------------------------------------

def reset():
    if bpy.data.filepath:
        raise SystemExit("scene.py clears the open file: run it in a new, unsaved Blender file (or with -b)")
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras,
                 bpy.data.worlds, bpy.data.images, bpy.data.node_groups):
        for item in list(coll):
            coll.remove(item)


def build(scale=100):
    t0 = time.time()
    reset()
    scene = bpy.context.scene
    dem = srtm.mosaic(HERE / "srtm_tiles")
    p = L.load_points(ROOT / "site/public/data/portugal/points/2017.csv")
    _, monthly = L.monthly_harmonized(ROOT / "site/public/data/portugal/series.json")
    n = len(p["t"])
    DEM[:] = [dem]
    S = {
        "dem": dem, "p": p, "on": L.on_frames(p), "ground_z": L.surface_km(dem, p["x"], p["y"]),
        "slots_t": L.timeline_slots(p["day"]), "slots_c": L.calendar_slots(monthly, n)[:2],
    }
    S["terrain"], S["grid"] = build_terrain(dem)
    S["squares"] = build_squares(p)
    # the squares burning when the story opens, as seen from its first viewpoint: the trees keep out of their way
    eye = L.camera(dem, 0)["eye"]
    burning = (L.heat(p, S["on"], 0) > 0.25) & (np.hypot(p["x"] - L.FIRE[0], p["y"] - L.FIRE[1]) < 25)
    targets = (p["x"][burning], p["y"][burning], S["ground_z"][burning] + 0.02)
    pines = tree_material()
    S["forest"] = build_forest(dem, eye, targets, pines)
    S["far_forest"], S["far_cells"] = build_far_forest(dem, eye, targets, pines, S["grid"])
    S["grass"] = build_grass(dem, eye)
    S["world"] = build_world()
    S["sky_light"], S["sun"], S["fire_lights"] = build_lights()
    S["air"] = build_smoke()
    S["sats"] = {"Aqua": build_satellite("Aqua", (-1,)), "SNPP": build_satellite("Suomi NPP", (1,))}
    S["lines"] = {"Aqua": build_scan_line("Scan line MODIS", (0.35, 0.6, 1.0), L.PIXEL_KM["modis"]),
                  "SNPP": build_scan_line("Scan line VIIRS", (1.0, 0.93, 0.8), L.PIXEL_KM["viirs"])}
    S["axis"], S["axis_emission"] = build_axis()

    cam = bpy.data.cameras.new("Camera")
    cam.sensor_width = 36.0
    cam.clip_end = 4000.0
    S["camera"] = add_object("Camera", cam)
    scene.camera = S["camera"]

    try:
        scene.render.engine = "BLENDER_EEVEE"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x, scene.render.resolution_y = 1600, 900
    scene.render.resolution_percentage = scale
    scene.render.film_transparent = False
    scene.frame_start, scene.frame_end = 0, L.FRAMES - 1
    scene.render.fps = 24
    ee = scene.eevee
    ee.taa_render_samples = 32
    ee.use_shadows = True
    ee.use_volumetric_shadows = False
    ee.volumetric_tile_size = "4"
    ee.volumetric_samples = 96
    ee.volumetric_sample_distribution = 0.9
    ee.use_volume_custom_range = True
    scene.view_settings.view_transform = "AgX"
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    S["glare"] = build_bloom(scene)
    scene["fe019"] = True
    print(f"scene built in {time.time() - t0:.1f} s: {n} detections")
    return S


def build_bloom(scene):
    """Glow around the hot squares, in the compositor."""
    tree = bpy.data.node_groups.new("Bloom", "CompositorNodeTree")
    tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    rl = tree.nodes.new("CompositorNodeRLayers")
    glare = tree.nodes.new("CompositorNodeGlare")
    out = tree.nodes.new("NodeGroupOutput")
    for name, value in (("Type", "Bloom"), ("Quality", "High"), ("Threshold", 0.7), ("Strength", 1.0), ("Size", 0.42),
                        ("Saturation", 1.0), ("Smoothness", 0.4)):
        try:
            glare.inputs[name].default_value = value
        except Exception as e:  # socket missing in this Blender: say so, keep going
            print(f"bloom: could not set {name}: {e}; inputs are {[i.name for i in glare.inputs]}")
    tree.links.new(rl.outputs["Image"], glare.inputs["Image"])
    tree.links.new(glare.outputs["Image"], out.inputs[0])
    scene.compositing_node_group = tree
    return glare


def value(datablock, name):
    return datablock.node_tree.nodes[name].outputs[0]


def apply(S, frame):
    """Puts everything where it belongs at rendered `frame` (0 to L.FRAMES - 1, may be fractional)."""
    t = L.story_time(frame)
    p, dem = S["p"], S["dem"]
    pos, size, heat = L.squares(p, S["ground_z"], S["on"], S["slots_t"], S["slots_c"], t)
    update_squares(S, pos, size, heat)
    n = len(heat)
    on_ground = L.to_timeline(n, t) < 0.02
    terrain = S["terrain"].data
    glow = ground_glow(S, pos, size, heat, on_ground)
    float_attr(terrain, "glow", glow.ravel())
    terrain.update()

    # camera
    c = L.camera(dem, t)
    eye, target = Vector(c["eye"]), Vector(c["target"])
    fwd = (target - eye).normalized()
    w = smooth((t - 30.0) / 24.0)  # up is the sky near the ground, north once we look straight down
    hint = (Vector((0, 0, 1)) * (1 - w) + Vector((0, 1, 0)) * w).normalized()
    right = fwd.cross(hint).normalized()
    up = right.cross(fwd)
    S["camera"].matrix_world = Matrix(((right.x, up.x, -fwd.x, eye.x), (right.y, up.y, -fwd.y, eye.y),
                                       (right.z, up.z, -fwd.z, eye.z), (0, 0, 0, 1)))
    cam = S["camera"].data
    cam.lens = c["mm"]
    above = max(eye.z - float(L.surface_km(dem, eye.x, eye.y)), 0.001)
    cam.clip_start = max(0.0004, above * 0.05)
    ee = bpy.context.scene.eevee
    ee.volumetric_start = cam.clip_start
    ee.volumetric_end = float(np.clip(above * 1.6 + 30.0, 30.0, 420.0))

    # sunset: the sun goes down behind the fire while the camera climbs out of the forest (t 0 to 30), then night
    sun = sun_vector(t)
    S["sun"].rotation_euler = (-sun).to_track_quat("-Z", "Y").to_euler()
    S["sun"].data.energy = ramp(t, [(0, 4.2), (12, 3.4), (20, 1.8), (25, 0.5), (27, 0.0)])
    S["sun"].data.color = [ramp(t, [(0, a), (14, b), (24, c)]) for a, b, c in zip((1.0, 0.88, 0.72), (1.0, 0.68, 0.42), (1.0, 0.46, 0.22))]
    S["sun"].hide_render = t >= 27
    world = S["world"]
    world.node_tree.nodes["to_sun"].inputs[1].default_value = sun
    world.node_tree.nodes["sun_colour"].inputs["Color1"].default_value = (
        1.0, ramp(t, [(0, 0.8), (22, 0.42)]), ramp(t, [(0, 0.55), (22, 0.12)]), 1.0)
    value(world, "day").default_value = ramp(t, [(0, 1.0), (8, 1.0), (18, 0.55), (26, 0.18), (36, 0.0)])
    value(world, "glow").default_value = ramp(t, [(0, 0.5), (12, 1.4), (22, 2.0), (30, 1.0), (40, 0.36)])
    value(world, "sun").default_value = ramp(t, [(0, 1.0), (22, 1.0), (27, 0.0)])
    value(world, "sky").default_value = ramp(t, [(0, 1.0), (40, 1.0), (60, 0.5)])
    # glow only from what is hotter than the day sky
    S["glare"].inputs["Threshold"].default_value = ramp(t, [(0, 1.6), (22, 1.6), (34, 0.7)])
    # night light: lighter than the first cut on the way up (trees and hills stay readable), clearest from high up,
    # then down again so the timeline carries the picture
    S["sky_light"].data.energy = ramp(t, [(0, 0.0), (16, 0.3), (30, 1.15), (40, 1.2), (54, 2.3), (100, 2.3), (144, 0.7), (179, 0.3)])
    fire_glow = ramp(t, [(0, 3.0), (16, 4.5), (36, 4.0), (72, 2.2), (108, 1.6), (144, 0.3)])
    value(S["terrain"].data.materials[0], "glow_strength").default_value = fire_glow
    value(S["forest"].data.materials[0], "glow_strength").default_value = fire_glow * 1.5
    # dimmer in daylight, where full strength reads as cream instead of fire
    value(S["squares"].data.materials[0], "gain").default_value = ramp(t, [(0, 0.6), (20, 1.0), (30, 1.3), (36, 1.1), (60, 1.0), (108, 1.0), (144, 0.9), (179, 0.8)])
    air = S["air"].data.materials[0]
    value(air, "smoke").default_value = ramp(t, [(0, 0.6), (24, 1.0), (40, 1.0), (56, 0.45), (90, 0.25), (120, 0.0)])
    value(air, "haze").default_value = ramp(t, [(0, 0.12), (20, 0.25), (34, 1.0), (40, 1.0), (60, 0.25), (110, 0.0)])  # thin in daylight
    S["air"].hide_render = t >= 120
    S["forest"].hide_render = t > 60
    S["grass"].hide_render = t > 28
    S["far_forest"].hide_render = t > 64
    if not S["far_forest"].hide_render:  # fire light on the ground, copied onto the pines standing in it
        me = S["far_forest"].data
        float_attr(me, "glow", glow.ravel()[S["far_cells"]])
        me.update()

    # the brightest fire clusters light the smoke and the hills from below
    hot = on_ground & (heat > 0.3) & (np.hypot(pos[:, 0] - L.FIRE[0], pos[:, 1] - L.FIRE[1]) < 45)
    cell = (np.floor(pos[hot, 0] / 6.0).astype(int) + 1000) * 10000 + np.floor(pos[hot, 1] / 6.0).astype(int) + 1000
    cells, inverse = np.unique(cell, return_inverse=True)
    weight = heat[hot] * size[hot] ** 2
    total = np.bincount(inverse, weight, len(cells)) if len(cells) else np.zeros(0)
    order = np.argsort(-total)[: len(S["fire_lights"])]
    power = ramp(t, [(0, 60.0), (36, 60.0), (60, 12.0), (80, 0.0)])
    for k, ob in enumerate(S["fire_lights"]):
        if k < len(order) and power > 0:
            sel = inverse == order[k]
            wsum = weight[sel].sum()
            cx, cy = (pos[hot][sel, 0] * weight[sel]).sum() / wsum, (pos[hot][sel, 1] * weight[sel]).sum() / wsum
            ob.location = (cx, cy, float(L.height_km(dem, cx, cy)) + 0.5)
            ob.data.energy = power * min(total[order[k]], 60.0)
            ob.hide_render = False
        else:
            ob.hide_render = True

    # satellites: each one rides above its scan line
    line = L.scan_line(t)
    for key in S["sats"]:
        sat, strip = S["sats"][key], S["lines"][key]
        active = line is not None and line[0]["satellite"] == key
        for ob in (strip, sat, *sat.children):
            ob.hide_render = not active
        if not active:
            continue
        s = line[1]
        side = -1.0 if key == "Aqua" else 1.0
        base = Vector((L.TRACK[0] * s, L.TRACK[1] * s, 0.0))
        strip.location = (base.x, base.y, 6.5)
        strip.rotation_euler = (0, 0, math.radians(-L.TRACK_AZ))
        z = eye.z * 0.42
        sat.location = (base.x + L.FIRE[0] + side * 0.20 * (eye.z - z), base.y, z)
        sat.rotation_euler = (0, 0, math.radians(-L.TRACK_AZ))
        sat.scale = (eye.z * 0.016,) * 3

    S["axis_emission"].inputs["Strength"].default_value = ramp(t, [(112, 0.0), (130, 1.6), (150, 1.6), (166, 0.0)])
    S["axis"].hide_render = not 112 < t < 166


def render(S, frames, out, quality=72):
    scene = bpy.context.scene
    out.mkdir(parents=True, exist_ok=True)
    scene.render.image_settings.file_format = "WEBP"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.quality = quality
    for f in frames:
        t0 = time.time()
        scene.frame_set(int(f))
        apply(S, f)
        scene.render.filepath = str(out / f"f{int(f):03d}.webp")
        bpy.ops.render.render(write_still=True)
        print(f"frame {int(f):3d} in {time.time() - t0:.1f} s", flush=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--all", action="store_true", help=f"render frames 0-{L.FRAMES - 1}")
    ap.add_argument("--frames", default="", help="comma-separated frames, or a-b ranges")
    ap.add_argument("--out", default=str(ROOT / "site/public/scene"))
    ap.add_argument("--scale", type=int, default=100, help="percent of 1600 x 900")
    ap.add_argument("--quality", type=int, default=72, help="WebP quality")
    ap.add_argument("--save", default="", help="also save the scene as this .blend")
    a = ap.parse_args(argv)
    S = build(a.scale)
    frames = list(range(L.FRAMES)) if a.all else []
    for part in filter(None, a.frames.split(",")):
        lo, _, hi = part.partition("-")
        frames += list(range(int(lo), int(hi or lo) + 1))
    apply(S, frames[0] if frames else 0)

    def on_frame(scene, *_):  # scrubbing the timeline in an open Blender
        apply(S, scene.frame_current)

    if not frames:
        bpy.app.handlers.frame_change_pre.append(on_frame)
    if a.save:
        bpy.ops.wm.save_as_mainfile(filepath=str(Path(a.save).resolve()))
    if frames:
        render(S, frames, Path(a.out), a.quality)


if __name__ == "__main__":
    main()
