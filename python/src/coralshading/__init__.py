"""Coral Shading Protocol v5: Python reference implementation (identical calculations to the browser app)."""
from pathlib import Path

__version__ = "5.1.0"

# Shared data (light tables, coral presets, examples, golden test values): the repository's shared/ folder when
# run from a checkout, otherwise the copy bundled in the package (python tools/sync_data.py before building).
_repo = Path(__file__).resolve().parents[3] / "shared"
SHARED = _repo if (_repo / "tables").exists() else Path(__file__).resolve().parent / "data"
