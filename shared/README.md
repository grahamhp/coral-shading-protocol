# Shared data

Files read by both the Python package and the browser app.

- `golden/`: test values written by the Python reference (`python -m coralshading.golden`); the TypeScript tests must match them.
- `references.json`: every source cited in the app's popups and the methods page.
- `examples/`: the preloaded example site (Sipaway).
- `tables/`: light-engine tables built by the Monte Carlo.
- `corals/`: coral photosynthesis–irradiance presets with sources (`pe_presets.json`).
- `validation/`: fast engine against the 3-D Monte Carlo (`engine_vs_mc.json`).
