import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build  # noqa: E402
import site_bundle  # noqa: E402

SENSORS = {s: {"first_date": "2001-01-01", "last_date": "2025-12-31", "data_through": "2025-12-31", "extra": 1}
           for s in ("terra", "aqua", "viirs", "n20", "n21")}
CELL_REGION = {"id": "portugal", "name": "Mainland Portugal", "bbox": [-10.0, 36.9, -6.0, 42.2], "fire_type": "x",
               "tier": "region", "data_through": "2026-11-02", "sensors": {}, "point_years": [2001], "point_rows": 5}


def put(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f)


class SiteBundle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        self.out = os.path.join(self.d, "out")
        self.grid = os.path.join(self.d, "grid")
        self.countries = os.path.join(self.d, "countries.json")
        os.makedirs(self.grid)
        put(os.path.join(self.out, "portugal", "annual.json"), {"years": [2001], "region": "portugal"})

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, index):
        return site_bundle.add_countries(index, out=self.out, countries_path=self.countries, grid_dir=self.grid)

    def test_no_countries_file_leaves_index_as_is(self):
        idx = {"schema": 1, "regions": [CELL_REGION]}
        self.assertEqual(self.add(idx), idx)

    def test_modelled_country_is_appended_with_manifest_dates_and_no_points(self):
        put(self.countries, [{"id": "greece", "name": "Greece", "country": "Greece", "tier": "country",
                              "bbox": [19.3, 34.8, 29.7, 41.8], "season": "Summer wildfire."},
                             {"id": "brazil", "name": "Brazil", "country": "Brazil", "tier": "country"}])
        put(os.path.join(self.grid, "manifest.json"), {"greece": {"archive_through": "2025-12-31", "sensors": SENSORS}})
        put(os.path.join(self.out, "greece", "annual.json"), {"years": [2001]})
        idx = self.add({"schema": 1, "regions": [CELL_REGION]})
        self.assertEqual([r["id"] for r in idx["regions"]], ["portugal", "greece"])
        g = idx["regions"][1]
        self.assertEqual(g["tier"], "country")
        self.assertEqual(g["data_through"], "2025-12-31")
        self.assertEqual(g["bbox"], [19.3, 34.8, 29.7, 41.8])
        self.assertEqual(g["season"], "Summer wildfire.")
        self.assertEqual((g["point_years"], g["point_rows"]), ([], 0))
        self.assertEqual(g["sensors"]["terra"], {"first_date": "2001-01-01", "last_date": "2025-12-31",
                                                 "data_through": "2025-12-31"})

    def test_rerun_rebuilds_country_entries_without_duplicates(self):
        put(self.countries, [{"id": "greece", "name": "Greece", "country": "Greece", "tier": "country", "bbox": [1, 2, 3, 4]}])
        put(os.path.join(self.grid, "manifest.json"), {"greece": {"archive_through": "2025-12-31", "sensors": SENSORS}})
        put(os.path.join(self.out, "greece", "annual.json"), {"years": [2001]})
        once = self.add({"schema": 1, "regions": [CELL_REGION]})
        self.assertEqual(self.add(once), once)

    def test_country_entry_kept_on_a_clone_without_the_grid_manifest(self):
        put(self.countries, [{"id": "greece", "name": "Greece", "country": "Greece", "tier": "country"}])
        put(os.path.join(self.out, "greece", "annual.json"), {"years": [2001]})
        entry = {"id": "greece", "name": "Greece", "bbox": [1, 2, 3, 4], "tier": "country", "point_years": [], "point_rows": 0}
        idx = self.add({"schema": 1, "regions": [CELL_REGION, entry]})
        self.assertEqual(idx["regions"], [CELL_REGION, entry])

    def test_country_dropped_from_countries_json_but_modelled_is_kept(self):
        put(os.path.join(self.out, "greece", "annual.json"), {"years": [2001]})
        entry = {"id": "greece", "name": "Greece", "bbox": [1, 2, 3, 4], "tier": "country"}
        with mock.patch("builtins.print"):
            idx = self.add({"schema": 1, "regions": [CELL_REGION, entry]})
        self.assertEqual(idx["regions"], [CELL_REGION, entry])

    def test_country_whose_annual_json_is_gone_is_dropped(self):
        entry = {"id": "greece", "name": "Greece", "bbox": [1, 2, 3, 4], "tier": "country"}
        self.assertEqual(self.add({"schema": 1, "regions": [CELL_REGION, entry]})["regions"], [CELL_REGION])

    def test_bbox_reused_from_index_so_the_grid_is_not_rescanned(self):
        put(self.countries, [{"id": "greece", "name": "Greece", "country": "Greece", "tier": "country"}])
        put(os.path.join(self.grid, "manifest.json"), {"greece": {"archive_through": "2025-12-31", "sensors": SENSORS}})
        put(os.path.join(self.out, "greece", "annual.json"), {"years": [2001]})
        entry = {"id": "greece", "name": "Greece", "bbox": [1, 2, 3, 4], "tier": "country"}
        with mock.patch.object(site_bundle, "grid_bbox", side_effect=AssertionError("rescanned")):
            idx = self.add({"schema": 1, "regions": [CELL_REGION, entry]})
        self.assertEqual(idx["regions"][1]["bbox"], [1, 2, 3, 4])

    def test_new_country_without_bbox_or_grid_fails_clearly(self):
        put(self.countries, [{"id": "greece", "name": "Greece", "country": "Greece", "tier": "country"}])
        put(os.path.join(self.grid, "manifest.json"), {"greece": {"archive_through": "2025-12-31", "sensors": SENSORS}})
        put(os.path.join(self.out, "greece", "annual.json"), {"years": [2001]})
        with self.assertRaises(SystemExit):
            self.add({"schema": 1, "regions": [CELL_REGION]})

    def test_country_without_manifest_entry_is_left_out(self):
        put(self.countries, [{"id": "greece", "name": "Greece", "country": "Greece", "tier": "country", "bbox": [1, 2, 3, 4]}])
        put(os.path.join(self.out, "greece", "annual.json"), {"years": [2001]})
        with mock.patch("builtins.print"):
            idx = self.add({"schema": 1, "regions": [CELL_REGION]})
        self.assertEqual([r["id"] for r in idx["regions"]], ["portugal"])

    def test_country_id_clashing_with_a_region_fails(self):
        put(self.countries, [{"id": "portugal", "name": "Portugal", "country": "Portugal", "tier": "country"}])
        with self.assertRaises(SystemExit):
            self.add({"schema": 1, "regions": [CELL_REGION]})

    def test_season_from_fire_type_when_countries_json_has_none(self):
        self.assertEqual(site_bundle.season_from("Boreal forest wildfire (peak Jun–Aug)"),
                         "Boreal forest wildfire (peak Jun to Aug).")
        self.assertEqual(site_bundle.season_from(""), "")
        put(self.countries, [{"id": "canada", "name": "Canada", "country": "Canada", "tier": "country",
                              "bbox": [1, 2, 3, 4], "fire_type": "Boreal forest wildfire (peak Jun–Aug)"}])
        put(os.path.join(self.grid, "manifest.json"), {"canada": {"archive_through": "2025-12-31", "sensors": SENSORS}})
        put(os.path.join(self.out, "canada", "annual.json"), {"years": [2001]})
        e = self.add({"schema": 1, "regions": []})["regions"][0]
        self.assertEqual(e["season"], "Boreal forest wildfire (peak Jun to Aug).")
        self.assertNotIn("caveat", e)

    def test_bbox_from_grid_cells_when_countries_json_has_none(self):
        p = os.path.join(self.grid, "fire_grid_daily_x.csv")
        with open(p, "w", encoding="utf-8") as f:
            f.write("date,lat,lon,daynight\n2001-01-01,10.0,-3.25,D\n2001-01-02,4.5,1.0,N\n")
        self.assertEqual(site_bundle.grid_bbox(p), [-3.25, 4.5, 1.25, 10.25])

    def test_record_fields_come_from_annual_json(self):
        put(os.path.join(self.out, "greece", "annual.json"),
            {"years": [2001, 2002], "forward_through": None, "ship": "caveat", "method": "model", "cell_deg": 1,
             "caveat": "Band too narrow in 2 of 6 years."})
        idx = {"regions": [dict(CELL_REGION), {"id": "greece", "tier": "country", "caveat": "Islands left out."},
                           {"id": "punjab", "first_year": 2001, "forward_through": "2026-11-14"}]}
        out = site_bundle.add_records(idx, out=self.out)["regions"]
        self.assertEqual((out[0]["first_year"], out[0]["forward_through"]), (2001, None))
        self.assertNotIn("ship", out[0])
        g = out[1]
        self.assertEqual((g["first_year"], g["ship"], g["method"], g["cell_deg"]), (2001, "caveat", "model", 1))
        self.assertEqual((g["caveat"], g["ship_caveat"]), ("Islands left out.", "Band too narrow in 2 of 6 years."))
        self.assertNotIn("first_year", out[2])

    def test_record_fields_are_idempotent_and_drop_stale_ship(self):
        put(os.path.join(self.out, "greece", "annual.json"), {"years": [2001], "ship": "ratio"})
        idx = {"regions": [{"id": "greece", "tier": "country", "ship": "model", "ship_caveat": "old"}]}
        once = site_bundle.add_records(idx, out=self.out)
        self.assertEqual(once["regions"][0]["ship"], "ratio")
        self.assertNotIn("ship_caveat", once["regions"][0])
        self.assertEqual(site_bundle.add_records(once, out=self.out), once)

    def test_iso_a3_copied_from_countries_json(self):
        put(self.countries, [{"id": "greece", "name": "Greece", "country": "Greece", "tier": "country",
                              "iso_a3": "GRC", "bbox": [1, 2, 3, 4]}])
        put(os.path.join(self.grid, "manifest.json"), {"greece": {"archive_through": "2025-12-31", "sensors": SENSORS}})
        put(os.path.join(self.out, "greece", "annual.json"), {"years": [2001]})
        self.assertEqual(self.add({"schema": 1, "regions": []})["regions"][0]["iso_a3"], "GRC")


class WriteIndexKeepsCountries(unittest.TestCase):
    def test_build_rewrites_regions_and_keeps_country_entries(self):
        with tempfile.TemporaryDirectory() as d:
            index = os.path.join(d, "index.json")
            country = {"id": "greece", "name": "Greece", "tier": "country", "point_years": [], "point_rows": 0}
            put(index, {"schema": 1, "regions": [dict(CELL_REGION, first_year=2001, forward_through="2026-11-14"), country]})
            regions = [{"id": "portugal", "name": "Mainland Portugal", "short_name": "Portugal", "country": "Portugal",
                        "bbox": [-10.0, 36.9, -6.0, 42.2], "fire_type": "x", "season": "Wildfire.", "caveat": "Careful."}]
            manifest = {"portugal": {"archive_through": "2026-11-02", "sensors": SENSORS}}
            with mock.patch.object(build, "INDEX", index):
                build.write_index(regions, manifest)
            with open(index, encoding="utf-8") as f:
                out = json.load(f)["regions"]
        self.assertEqual([r["id"] for r in out], ["portugal", "greece"])
        p = out[0]
        self.assertEqual((p["short_name"], p["tier"], p["season"], p["caveat"]), ("Portugal", "region", "Wildfire.", "Careful."))
        self.assertEqual(p["point_years"], [2001])
        self.assertEqual((p["first_year"], p["forward_through"]), (2001, "2026-11-14"))
        self.assertEqual(out[1], country)

    def test_check_regions_rejects_a_country_tier_in_regions_json(self):
        r = {"id": "greece", "name": "Greece", "country": "Greece", "bbox": [1, 2, 3, 4], "fire_type": "x", "tier": "country"}
        with self.assertRaises(SystemExit):
            build.check_regions([r])


if __name__ == "__main__":
    unittest.main()
