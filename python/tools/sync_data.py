"""Copy the shared data the package needs into src/coralshading/data before building a wheel."""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DST = ROOT / "python" / "src" / "coralshading" / "data"
for rel in ["tables/light_tables.json", "corals/pe_presets.json", "examples/sipaway.json", "references.json"]:
    (DST / rel).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "shared" / rel, DST / rel)
    print("copied", rel)
