# Shared data

Files read by both the Python package and the browser app.

- `golden/`: test values written by the Python reference (`python -m coralshading.golden`); the TypeScript tests must match them.
- `references.json`: every source cited in the app's popups and the methods page.
- `examples/`: the example reefs bundled with the app (Sipaway and nine more; PVGIS typical years; `python -c "from coralshading import examples; examples.build_examples()"` rebuilds them).
- `tables/`: light-engine tables built by the Monte Carlo.
- `corals/`: coral photosynthesis–irradiance presets with sources (`pe_presets.json`).
- `validation/`: fast engine against the 3-D Monte Carlo (`engine_vs_mc.json`; days through a deployment in `engine_vs_mc_days.json`) and the light-source comparison (`light_sources.json`).
