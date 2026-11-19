# Release steps for v5.0.0

These need the repository owner (GitHub settings, Zenodo).

1. **Tag the old versions first** so they stay citable:
   `git tag -a v3.2 3b45b53c -m "Coral Shading Protocol v3.2"` and
   `git tag -a v4.2 f3c2957a -m "Last version before v5"`, then `git push --tags`.
2. **Clean the working folder:** delete `app/`, `web/`, `_scratch_npm_test/` and `_scratch_npm_test2/`
   (left over from failed installs; not part of v5). Replace `python/pyproject.toml` with
   `python/pyproject.proposed.toml`. Add a `LICENSE` file (MIT unless you choose otherwise).
3. **Check:** `cd python && python -m pytest`; `cd webapp && npm test && npm run build`. Open
   `webapp/dist/index.html` in Chrome, Firefox and Safari; run the Sipaway example in simple and expert mode.
4. **Publish the app:** Settings → Pages → Source: GitHub Actions. The workflow in
   `.github/workflows/tests.yml` then publishes `webapp/dist/` on every push to `main` once both test suites pass.
   The app is one file, so any static host also works (including your own website: upload `index.html`).
5. **Archive with a DOI:** connect the repository at zenodo.org (GitHub integration), then create a GitHub
   release `v5.0.0`. Zenodo archives it and issues a DOI. Add the DOI to `CITATION.cff` and `README.md`.
6. **Python package (optional):** `python -m build` in `python/`, then `twine upload dist/*` to PyPI as
   `coral-shading-protocol`.

# Release steps for v5.1.0

1. Review the branch `v5.1.0` (pull request into `main`). Merging publishes the app, because the workflow deploys
   `main` to GitHub Pages once both test suites pass.
2. Before merging: confirm the design ω₀ of 0.7 (DECISIONS 54) and the release date in `CITATION.cff`.
3. **Check:** `cd python && python -m pytest`; `cd webapp && npx tsc -p tsconfig.json && npm test && npm run build`.
   Open `webapp/dist/index.html`; run the example in simple and expert mode, and in expert mode try a board
   reading, Kd by date, a tide series and fouling.
4. After merging: tag `v5.1.0` on `main` and create the GitHub release (Zenodo then issues a new version DOI).
