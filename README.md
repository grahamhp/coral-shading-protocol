# Coral Shading Protocol v5.1

A design tool for shading corals during heat stress. It sizes a shade cloth (constant shading) or an opaque
canopy that shades the corals only around midday (dynamic shading), and shows the light the corals receive
under each, point by point, over a deployment.

There are two products with identical calculations:

- **The browser app** (`webapp/`): one HTML file. Use it at
  **https://grahamhp.github.io/coral-shading-protocol/**, or save that page and open it offline. No installation
  and no Python.
- **The Python package** `coralshading` (`python/`): the reference implementation, for scripts, batch runs and
  checks with the full 3-D Monte Carlo. It downloads light data from PVGIS automatically.

## Using the app

Enter the site (map or coordinates), the deployment dates, the coral area (a MARRS Reef Star, a table, a rope or
any rectangle or circle), its depth, the structure height and the water clarity (Kd; a popup gives typical values
with sources). The app shows:

- the size of the shade cloth and the canopy;
- daily light (mol m⁻² d⁻¹) under each and in open water, as maps and curves through the day;
- light at noon and in the morning and afternoon, hours with the sun in line, light reduction and the coral's
  expected photosynthesis and P:R;
- the likely range of every result, from how strongly the water scatters light sideways (ω₀, rarely measured);
- how much the result changes with water clarity, water scattering, wind and the structure's position.

Simple mode asks for the essentials; expert mode adds water scattering and its range (or ω₀ fitted from one
reading under an opaque board), water clarity by date, a tide record, cloth fouling and cleaning over time,
independent cloth and canopy targets, set structure sizes, wind, grid spacing and coral parameters. Both modes let you set
solar noon. A first answer
appears in about 0.2 s; the full result follows in a few seconds. Results export as CSV and JSON.

Light data: one example site (Sipaway Island, Philippines; PVGIS typical year) is built in so the app works
offline. For other sites the app opens the PVGIS download for the site (a
typical year or real years); load the saved file or paste its text. PVGIS does not allow web pages to fetch
its data directly, so this takes one extra click.

## Using the Python package

```
pip install ./python
coralshading design --lat 10.4675 --lon 123.4506 --tz 8 --start 2025-04-28 --end 2025-08-08 \
    --target reef_star --depth 10 --height 0.75 --kd 0.21 --light tmy --out results/
# options: --w0 0.7 --w0-range 0.5-0.9 | --w0-reading RATIO LX LY HEIGHT --reading-time "2025-05-22 12:00" --reading-err 0.02
#          --kd-series kd.csv --tide tide.csv --fouling 0.2 0.12 30 21 --acclimate time
```

```python
from coralshading.design import design
r = design(lat=10.4675, lon=123.4506, tz=8, start=(2025, 4, 28), end=(2025, 8, 8), kd=0.21)
print(r.summary())
r.to_csv("results/")
r.mc_check()        # check the design with the 3-D Monte Carlo (a few minutes)
```

A full 103-day design at the 5 cm grid takes about 3 minutes in Python (`spacing=0.1` is faster); the app
takes a few seconds because it reorganizes the same equations for speed (the test suite checks that both give
the same numbers). See
`python/examples/quickstart.ipynb`.

## How it works

Surface light (PVGIS, hourly) → PAR → refraction and waves at the surface → light in the water from tables made
once by Monte Carlo for the water's clarity (Kd) and scattering (ω₀) → light at each point under the structures,
direction by direction. Details and references: [docs/methods.md](docs/methods.md). Accuracy against an
independent 3-D Monte Carlo: [docs/validation.md](docs/validation.md). Design choices and their reasons:
[docs/DECISIONS.md](docs/DECISIONS.md). Measuring a site: [docs/field_protocol.md](docs/field_protocol.md).

## Versions

- **v1.0**: sized the opaque canopy in the Sipaway shading experiment. Its files were lost in a hardware
  failure.
- **v3.2** (tag `v3.2`, commit `3b45b53c`): earlier public version.
- **v4.2** (tag `v4.2`, commit `f3c2957a`): last version before v5. Attenuates direct and diffuse light
  vertically with one Kd. Still available at https://grahamhp.github.io/coral-shading-protocol/v4.2/.
- **v5.0** (tag `v5.0.0`): rebuilt on radiative transfer. See [CHANGELOG.md](CHANGELOG.md).
- **v5.1**: every day in every calculation; ω₀ range on every result and ω₀ from a field reading; water clarity
  by date, tide, cloth fouling over time and coral acclimation over time; circumsolar sky light; light at noon
  versus morning and afternoon; the assumptions stated on every export. See [CHANGELOG.md](CHANGELOG.md).

## Repository

- `webapp/`: browser app (TypeScript; `npm run build` writes `webapp/dist/index.html`).
- `python/`: Python package and tests.
- `shared/`: data both products read: light tables, coral presets, references, example data, golden test
  values and validation results.
- `docs/`: methods, validation, decisions, field protocol, release steps and methods-paper groundwork
  (with figures).
- `legacy/v4.2/`: the v4.2 app, published alongside v5 at `/v4.2/`.

## Development

- Python tests: `cd python && python -m pytest`
- App tests: `cd webapp && npm test` (Node 22.18 or later; runs TypeScript directly)
- App type check: `cd webapp && npx tsc -p tsconfig.json`
- App build: `cd webapp && npm run build`
- After changing the engine, regenerate the golden values (`python -m coralshading.golden`) and run both test
  suites; the app must reproduce the Python values to 10⁻⁹.

## Citing

See [CITATION.cff](CITATION.cff). Please cite the version you used.

## Licence

MIT. See [LICENSE](LICENSE).
