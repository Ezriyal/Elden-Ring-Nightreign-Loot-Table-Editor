"""Rebuilds Nightreign-Loot-Rarity-Editor.html from the files in this folder.
Usage: python src/assemble.py [output.html]"""
import sys, base64, pathlib
B = pathlib.Path(__file__).resolve().parent
VERSION = "1.1.1"
t = (B / "template.html").read_text(encoding="utf-8")
t = t.replace("__ZSTDWASM_B64__", base64.b64encode((B / "nrzstd.wasm").read_bytes()).decode())
for key, fn in [("__ZSTD__", "zstd.js"), ("__ZSTDWASM__", "zstdwasm.js"), ("__CORE__", "core.js"), ("__UI__", "ui.js")]:
    t = t.replace(key, (B / fn).read_text(encoding="utf-8"))
t = t.replace("__NAMES__", (B / "names.json").read_text(encoding="utf-8")).replace("__VERSION__", VERSION)
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else B.parent / "Nightreign-Loot-Rarity-Editor.html"
out.write_text(t, encoding="utf-8", newline="\n")
print("wrote", out)
