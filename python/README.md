# coralshading

Python reference implementation of the Coral Shading Protocol v5. The browser app in `../webapp/` gives
identical results; the test suites check this.

```
pip install .
coralshading design --lat 10.4675 --lon 123.4506 --tz 8 --start 2025-04-28 --end 2025-08-08 --depth 10 --kd 0.21 --rating 80
```

```python
from coralshading.design import design
r = design(lat=10.4675, lon=123.4506, tz=8, start=(2025, 4, 28), end=(2025, 8, 8), depth=10, kd=0.21, cloth_rating=80)
print(r.summary())
r.to_csv("results/")     # points.csv (maps), days.csv, robustness.csv
r.mc_check()             # 3-D Monte Carlo at the center and east and west edges, 3 h before noon, noon, 3 h after
```

Light data: `light="tmy"` downloads a PVGIS typical year; `light=(2014, 2023)` real hourly years;
`light="example"` the built-in Sipaway year; or a path to a PVGIS CSV.

Modules: `solar` (sun position), `surface` (PVGIS, PAR), `optics` (refraction, waves), `mc` (Monte Carlo),
`build_tables` (light tables), `engine` (fast light engine), `geometry`, `scenarios` (cloth and canopy designs,
checks), `pe` (coral photosynthesis), `design` (one call for everything), `golden` (test values for the app).

Methods: `../docs/methods.md`. Tests: `python -m pytest`.
