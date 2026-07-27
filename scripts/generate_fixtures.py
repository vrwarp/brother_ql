#!/usr/bin/env python3
"""
Generate the golden test fixtures for the TypeScript/WebUSB port.

The fixtures are produced by the in-tree Python implementation (``brother_ql/``),
which is the reference for the wire protocol. The TypeScript test suite replays
them and asserts byte-for-byte equality, so any behavioural drift between the two
implementations shows up as a test failure.

Input images are *not* committed as pixel data. They are generated procedurally
by simple integer arithmetic that is reimplemented identically on the TypeScript
side; the manifest records a SHA-256 of each image's RGBA bytes so that the test
suite proves both generators agree before comparing any protocol output.

Usage::

    python scripts/generate_fixtures.py            # (re)write test/fixtures/
    python scripts/generate_fixtures.py --check     # verify committed fixtures
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import shutil
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from PIL import Image  # noqa: E402
import PIL.ImageChops  # noqa: E402
import PIL.ImageOps  # noqa: E402
import packbits  # noqa: E402

from brother_ql.conversion import convert  # noqa: E402
from brother_ql.image_trafos import filtered_hsv  # noqa: E402
from brother_ql.labels import ALL_LABELS  # noqa: E402
from brother_ql.models import ALL_MODELS  # noqa: E402
from brother_ql.raster import BrotherQLRaster  # noqa: E402

FIXTURES_DIR = REPO_ROOT / "test" / "fixtures"


# --------------------------------------------------------------------------
# Procedural image generators
#
# Every generator returns raw RGBA bytes. They use only integer arithmetic so
# that the TypeScript reimplementation in test/util/generators.ts can produce
# identical output.
# --------------------------------------------------------------------------


def gen_checker(w: int, h: int, cell: int = 8) -> bytearray:
    px = bytearray(w * h * 4)
    i = 0
    for y in range(h):
        for x in range(w):
            v = 0 if ((x // cell) + (y // cell)) % 2 == 0 else 255
            px[i] = v
            px[i + 1] = v
            px[i + 2] = v
            px[i + 3] = 255
            i += 4
    return px


def gen_stripes(w: int, h: int, period: int = 10) -> bytearray:
    px = bytearray(w * h * 4)
    i = 0
    for y in range(h):
        for x in range(w):
            v = 255 if ((x + y) % period) < (period // 2) else 0
            px[i] = v
            px[i + 1] = v
            px[i + 2] = v
            px[i + 3] = 255
            i += 4
    return px


def gen_gradient(w: int, h: int) -> bytearray:
    """Horizontal grey ramp; exercises thresholding and dithering."""
    px = bytearray(w * h * 4)
    i = 0
    denom = max(1, w - 1)
    for _y in range(h):
        for x in range(w):
            v = (x * 255) // denom
            px[i] = v
            px[i + 1] = v
            px[i + 2] = v
            px[i + 3] = 255
            i += 4
    return px


def gen_rgbsweep(w: int, h: int) -> bytearray:
    """
    Multiplicative sweep across the RGB cube.

    Coprime multipliers make consecutive pixels land in very different parts of
    the colour space, so the red/black HSV split is exercised right at its
    hue < 40 / hue > 210, saturation > 100 and value > 80 boundaries.
    """
    px = bytearray(w * h * 4)
    i = 0
    for y in range(h):
        for x in range(w):
            idx = y * w + x
            px[i] = (idx * 7) % 256
            px[i + 1] = (idx * 13) % 256
            px[i + 2] = (idx * 29) % 256
            px[i + 3] = 255
            i += 4
    return px


def gen_alpha_disc(w: int, h: int) -> bytearray:
    """Coloured sweep masked by a disc with a soft (partially transparent) edge."""
    px = bytearray(w * h * 4)
    cx, cy = w // 2, h // 2
    outer = min(w, h) // 2
    inner = outer // 2
    i = 0
    for y in range(h):
        for x in range(w):
            idx = y * w + x
            dx, dy = x - cx, y - cy
            d = math.isqrt(dx * dx + dy * dy)
            if d <= inner:
                a = 255
            elif d >= outer:
                a = 0
            else:
                a = 255 - (255 * (d - inner)) // (outer - inner)
            px[i] = (idx * 7) % 256
            px[i + 1] = (idx * 13) % 256
            px[i + 2] = (idx * 29) % 256
            px[i + 3] = a
            i += 4
    return px


def gen_allblack(w: int, h: int) -> bytearray:
    px = bytearray(w * h * 4)
    for i in range(0, len(px), 4):
        px[i + 3] = 255
    return px


def gen_noise(w: int, h: int, seed: int = 1234) -> bytearray:
    """Deterministic LCG noise (Numerical Recipes constants)."""
    px = bytearray(w * h * 4)
    s = seed & 0xFFFFFFFF
    i = 0
    for _y in range(h):
        for _x in range(w):
            s = (s * 1664525 + 1013904223) & 0xFFFFFFFF
            v = (s >> 24) & 0xFF
            px[i] = v
            px[i + 1] = v
            px[i + 2] = v
            px[i + 3] = 255
            i += 4
    return px


GENERATORS = {
    "checker": gen_checker,
    "stripes": gen_stripes,
    "gradient": gen_gradient,
    "rgbsweep": gen_rgbsweep,
    "alphadisc": gen_alpha_disc,
    "allblack": gen_allblack,
    "noise": gen_noise,
}

# Generators whose output carries meaningful alpha; everything else is handed to
# the Python pipeline as an opaque RGB image, which is what a caller loading a
# JPEG/PNG without transparency would get.
ALPHA_GENERATORS = {"alphadisc"}


class InputSpec:
    def __init__(self, gen: str, width: int, height: int, **params):
        self.gen = gen
        self.width = width
        self.height = height
        self.params = params

    @property
    def name(self) -> str:
        suffix = "".join(f"-{k}{v}" for k, v in sorted(self.params.items()))
        return f"{self.gen}-{self.width}x{self.height}{suffix}"

    @property
    def mode(self) -> str:
        return "RGBA" if self.gen in ALPHA_GENERATORS else "RGB"

    def rgba(self) -> bytearray:
        return GENERATORS[self.gen](self.width, self.height, **self.params)

    def image(self) -> Image.Image:
        im = Image.frombytes("RGBA", (self.width, self.height), bytes(self.rgba()))
        return im if self.mode == "RGBA" else im.convert("RGB")


# --------------------------------------------------------------------------
# Fixture definitions
# --------------------------------------------------------------------------

# Plane fixtures isolate each stage of the imaging pipeline so a failure points
# at the responsible step instead of only at the final byte stream.
PLANE_INPUT = InputSpec("noise", 200, 120)
GRADIENT_PLANE_INPUT = InputSpec("gradient", 200, 120)
COLOR_PLANE_INPUT = InputSpec("rgbsweep", 200, 120)
ALPHA_PLANE_INPUT = InputSpec("alphadisc", 200, 120)

# The golden matrix: every model is covered at least once, and every optional
# feature of the protocol appears in at least one case.
#
# compare modes:
#   exact           - the whole instruction stream must match byte for byte
#   framing         - non-raster instructions must match exactly, and raster rows
#                     must agree in count and length, but row payloads are not
#                     compared (used where Pillow's resampling is involved)
CASES = [
    # --- older models without optional features -------------------------------
    dict(id="ql500-62", model="QL-500", label="62",
         inputs=[InputSpec("checker", 696, 300)], options={}, compare="exact"),
    dict(id="ql550-29", model="QL-550", label="29",
         inputs=[InputSpec("stripes", 306, 200)], options={}, compare="exact"),
    dict(id="ql560-d12", model="QL-560", label="d12",
         inputs=[InputSpec("checker", 94, 94)], options={}, compare="exact"),
    dict(id="ql570-62-nocut", model="QL-570", label="62",
         inputs=[InputSpec("checker", 696, 200)], options={"cut": False}, compare="exact"),
    dict(id="ql580n-38-compress", model="QL-580N", label="38",
         inputs=[InputSpec("noise", 413, 160)], options={"compress": True}, compare="exact"),
    dict(id="ql650td-54", model="QL-650TD", label="54",
         inputs=[InputSpec("stripes", 590, 200)], options={}, compare="exact"),

    # --- die-cut geometry and rotation ---------------------------------------
    dict(id="ql700-29x90", model="QL-700", label="29x90",
         inputs=[InputSpec("checker", 306, 991)], options={}, compare="exact"),
    dict(id="ql700-29x90-autorot", model="QL-700", label="29x90",
         inputs=[InputSpec("checker", 991, 306)], options={"rotate": "auto"}, compare="exact"),
    dict(id="ql700-62x100-multi", model="QL-700", label="62x100",
         inputs=[InputSpec("checker", 696, 1109),
                 InputSpec("stripes", 696, 1109),
                 InputSpec("gradient", 696, 1109)],
         options={}, compare="exact"),
    dict(id="ql710w-62x29-compress", model="QL-710W", label="62x29",
         inputs=[InputSpec("checker", 696, 271)], options={"compress": True}, compare="exact"),
    dict(id="ql720nw-50-thresh30", model="QL-720NW", label="50",
         inputs=[InputSpec("gradient", 554, 240)], options={"threshold": 30}, compare="exact"),

    # --- QL-8xx: 400 byte invalidate, two colour ------------------------------
    dict(id="ql800-62-thresh90", model="QL-800", label="62",
         inputs=[InputSpec("gradient", 696, 300)], options={"threshold": 90}, compare="exact"),
    # QL-800 has no compression support: the request must be dropped silently.
    dict(id="ql800-62-compressreq", model="QL-800", label="62",
         inputs=[InputSpec("checker", 696, 120)], options={"compress": True}, compare="exact"),
    dict(id="ql800-62red-red", model="QL-800", label="62red",
         inputs=[InputSpec("rgbsweep", 696, 300)], options={"red": True}, compare="exact"),
    dict(id="ql810w-62-lq", model="QL-810W", label="62",
         inputs=[InputSpec("checker", 696, 200)], options={"hq": False}, compare="exact"),
    # All-black input makes the 600 dpi width halving independent of the
    # resampling filter, so this case can be compared exactly.
    dict(id="ql810w-62-600dpi-black", model="QL-810W", label="62",
         inputs=[InputSpec("allblack", 1392, 600)], options={"dpi_600": True}, compare="exact"),
    # Here the halving does depend on the filter (Pillow BICUBIC vs our box
    # average), so only the command framing is compared.
    dict(id="ql810w-62x29-600dpi", model="QL-810W", label="62x29",
         inputs=[InputSpec("stripes", 1392, 542)], options={"dpi_600": True}, compare="framing"),
    dict(id="ql810w-62red-alpha", model="QL-810W", label="62red",
         inputs=[InputSpec("alphadisc", 696, 300)], options={"red": True}, compare="exact"),
    dict(id="ql820nwb-62x29-dither", model="QL-820NWB", label="62x29",
         inputs=[InputSpec("gradient", 696, 271)], options={"dither": True}, compare="exact"),
    dict(id="ql820nwb-d24", model="QL-820NWB", label="d24",
         inputs=[InputSpec("checker", 236, 236)], options={}, compare="exact"),
    dict(id="ql820nwb-62-rot90", model="QL-820NWB", label="62",
         inputs=[InputSpec("checker", 300, 696)], options={"rotate": 90}, compare="exact"),
    dict(id="ql820nwb-d58-rot180", model="QL-820NWB", label="d58",
         inputs=[InputSpec("rgbsweep", 618, 618)], options={"rotate": 180}, compare="exact"),

    # --- wide format: 162 bytes/row and additional_offset_r = 44 ---------------
    dict(id="ql1050-102x51", model="QL-1050", label="102x51",
         inputs=[InputSpec("checker", 1164, 526)], options={}, compare="exact"),
    dict(id="ql1060n-62", model="QL-1060N", label="62",
         inputs=[InputSpec("checker", 696, 240)], options={}, compare="exact"),
    dict(id="ql1100-103x164", model="QL-1100", label="103x164",
         inputs=[InputSpec("stripes", 1200, 1822)], options={}, compare="exact"),
    dict(id="ql1110nwb-102x152", model="QL-1110NWB", label="102x152",
         inputs=[InputSpec("checker", 1164, 1660)], options={}, compare="exact"),
    dict(id="ql1115nwb-103", model="QL-1115NWB", label="103",
         inputs=[InputSpec("stripes", 1200, 400)], options={}, compare="exact"),

    # --- P-touch: 0x47 raster rows with a 16 bit length ------------------------
    dict(id="ptp750w-pt24", model="PT-P750W", label="pt24",
         inputs=[InputSpec("checker", 128, 400)], options={}, compare="exact"),
    dict(id="ptp900w-pt24", model="PT-P900W", label="pt24",
         inputs=[InputSpec("checker", 128, 400)], options={}, compare="exact"),
]

PACKBITS_CASES = [
    b"",
    b"\x00",
    b"\xff",
    b"\x01\x02\x03\x04\x05",
    b"\xaa" * 3,
    b"\xaa" * 127,
    b"\xaa" * 128,
    b"\xaa" * 129,
    b"\xaa" * 300,
    bytes(range(128)),
    bytes(range(200)) if False else bytes(i % 256 for i in range(200)),
    b"\x01\x01\x02\x02\x03\x03",
    b"\x00" * 90,
    b"\xff" * 162,
    bytes([0] * 40 + [255] * 40 + [0, 255] * 5),
]


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(bytes(data)).hexdigest()


def write_gz(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0 keeps the archive byte-stable across runs.
    path.write_bytes(gzip.compress(bytes(data), compresslevel=9, mtime=0))


def read_gz(path: Path) -> bytes:
    return gzip.decompress(path.read_bytes())


def dump_tables() -> dict:
    models = [
        dict(
            identifier=m.identifier,
            minMaxLengthDots=list(m.min_max_length_dots),
            minMaxFeed=list(m.min_max_feed),
            numberBytesPerRow=m.number_bytes_per_row,
            additionalOffsetR=m.additional_offset_r,
            modeSetting=bool(m.mode_setting),
            cutting=bool(m.cutting),
            expandedMode=bool(m.expanded_mode),
            compression=bool(m.compression),
            twoColor=bool(m.two_color),
            numInvalidateBytes=m.num_invalidate_bytes,
        )
        for m in ALL_MODELS
    ]
    labels = [
        dict(
            identifier=l.identifier,
            tapeSize=list(l.tape_size),
            formFactor=int(l.form_factor),
            dotsTotal=list(l.dots_total),
            dotsPrintable=list(l.dots_printable),
            offsetR=l.offset_r,
            feedMargin=l.feed_margin,
            restrictedToModels=list(l.restricted_to_models),
            color=int(l.color),
            name=l.name,
        )
        for l in ALL_LABELS
    ]
    return {"models": models, "labels": labels}


def build_planes(out: Path) -> list[dict]:
    """Intermediate images that pin down each stage of the imaging pipeline."""
    planes: list[dict] = []

    def add(plane_id: str, spec: InputSpec, kind: str, data: bytes) -> None:
        rel = f"planes/{plane_id}.bin.gz"
        write_gz(out / rel, data)
        planes.append(
            dict(
                id=plane_id,
                input=spec.name,
                kind=kind,
                file=rel,
                width=spec.width,
                height=spec.height,
                sha256=sha256_hex(data),
            )
        )

    # Greyscale conversion and inversion, from an opaque RGB image.
    im = PLANE_INPUT.image()
    grey = im.convert("L")
    add("grey-noise", PLANE_INPUT, "grey", grey.tobytes())
    add("invgrey-noise", PLANE_INPUT, "invgrey", PIL.ImageOps.invert(grey).tobytes())

    # Threshold and Floyd-Steinberg dithering, on the inverted greyscale.
    grad = GRADIENT_PLANE_INPUT.image()
    inv_grad = PIL.ImageOps.invert(grad.convert("L"))
    threshold = min(255, max(0, int((100.0 - 70) / 100.0 * 255)))
    add(
        "threshold70-gradient",
        GRADIENT_PLANE_INPUT,
        "bilevel",
        inv_grad.point(lambda x: 0 if x < threshold else 255, mode="1").tobytes(),
    )
    add(
        "dither-gradient",
        GRADIENT_PLANE_INPUT,
        "bilevel",
        inv_grad.convert("1", dither=Image.FLOYDSTEINBERG).tobytes(),
    )
    inv_noise = PIL.ImageOps.invert(PLANE_INPUT.image().convert("L"))
    add(
        "dither-noise",
        PLANE_INPUT,
        "bilevel",
        inv_noise.convert("1", dither=Image.FLOYDSTEINBERG).tobytes(),
    )

    # HSV conversion, which Pillow performs in single precision floats.
    colour = COLOR_PLANE_INPUT.image()
    h, s, v = colour.convert("HSV").split()
    add("hsv-h-rgbsweep", COLOR_PLANE_INPUT, "hsv-h", h.tobytes())
    add("hsv-s-rgbsweep", COLOR_PLANE_INPUT, "hsv-s", s.tobytes())
    add("hsv-v-rgbsweep", COLOR_PLANE_INPUT, "hsv-v", v.tobytes())

    # Alpha compositing onto white, exactly as conversion.py performs it.
    alpha_im = ALPHA_PLANE_INPUT.image()
    bg = Image.new("RGB", alpha_im.size, (255, 255, 255))
    bg.paste(alpha_im, alpha_im.split()[-1])
    add("composite-alphadisc", ALPHA_PLANE_INPUT, "rgb", bg.tobytes())
    add("grey-alphadisc", ALPHA_PLANE_INPUT, "grey", bg.convert("L").tobytes())

    # The red/black separation used for DK-22251 media.
    red_im = filtered_hsv(
        colour,
        lambda hh: 255 if (hh < 40 or hh > 210) else 0,
        lambda ss: 255 if ss > 100 else 0,
        lambda vv: 255 if vv > 80 else 0,
    )
    red_im = PIL.ImageOps.invert(red_im.convert("L"))
    red_im = red_im.point(lambda x: 0 if x < threshold else 255, mode="1")
    black_im = filtered_hsv(
        colour,
        lambda hh: 255,
        lambda ss: 255,
        lambda vv: 255 if vv < 80 else 0,
    )
    black_im = PIL.ImageOps.invert(black_im.convert("L"))
    black_im = black_im.point(lambda x: 0 if x < threshold else 255, mode="1")
    black_im = PIL.ImageChops.subtract(black_im, red_im)
    add("red-rgbsweep", COLOR_PLANE_INPUT, "bilevel", red_im.tobytes())
    add("black-rgbsweep", COLOR_PLANE_INPUT, "bilevel", black_im.tobytes())

    return planes


def build_fixtures(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)

    inputs: dict[str, dict] = {}

    def register(spec: InputSpec) -> None:
        if spec.name in inputs:
            return
        inputs[spec.name] = dict(
            gen=spec.gen,
            width=spec.width,
            height=spec.height,
            params=spec.params,
            mode=spec.mode,
            sha256=sha256_hex(spec.rgba()),
        )

    for spec in (PLANE_INPUT, GRADIENT_PLANE_INPUT, COLOR_PLANE_INPUT, ALPHA_PLANE_INPUT):
        register(spec)

    planes = build_planes(out)

    cases_out = []
    for case in CASES:
        for spec in case["inputs"]:
            register(spec)

        qlr = BrotherQLRaster(case["model"])
        qlr.exception_on_warning = False
        images = [spec.image() for spec in case["inputs"]]
        data = convert(qlr=qlr, images=images, label=case["label"], **case["options"])

        rel = f"expected/{case['id']}.bin.gz"
        write_gz(out / rel, data)
        cases_out.append(
            dict(
                id=case["id"],
                model=case["model"],
                label=case["label"],
                inputs=[spec.name for spec in case["inputs"]],
                options=case["options"],
                compare=case["compare"],
                file=rel,
                bytes=len(data),
                sha256=sha256_hex(data),
            )
        )

    packbits_out = [
        dict(raw=bytes(case).hex(), encoded=bytes(packbits.encode(case)).hex())
        for case in PACKBITS_CASES
    ]

    tables = dump_tables()
    (out / "tables").mkdir(parents=True, exist_ok=True)
    (out / "tables" / "models.json").write_text(
        json.dumps(tables["models"], indent=2) + "\n", encoding="utf-8"
    )
    (out / "tables" / "labels.json").write_text(
        json.dumps(tables["labels"], indent=2) + "\n", encoding="utf-8"
    )

    manifest = dict(
        generatedBy="scripts/generate_fixtures.py",
        pillowVersion=Image.__version__,
        inputs=inputs,
        planes=planes,
        packbits=packbits_out,
        cases=cases_out,
    )
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def compare_trees(reference: Path, candidate: Path) -> list[str]:
    """Semantic comparison: gzip members are compared after decompression."""
    problems: list[str] = []

    ref_files = {p.relative_to(reference) for p in reference.rglob("*") if p.is_file()}
    cand_files = {p.relative_to(candidate) for p in candidate.rglob("*") if p.is_file()}

    for missing in sorted(ref_files - cand_files):
        problems.append(f"missing fixture: {missing}")
    for extra in sorted(cand_files - ref_files):
        problems.append(f"unexpected fixture (stale?): {extra}")

    for rel in sorted(ref_files & cand_files):
        a, b = reference / rel, candidate / rel
        if rel.suffix == ".gz":
            da, db = read_gz(a), read_gz(b)
        else:
            da, db = a.read_bytes(), b.read_bytes()
        if da != db:
            problems.append(
                f"content differs: {rel} ({len(da)} vs {len(db)} bytes after decompression)"
            )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the committed fixtures instead of rewriting them",
    )
    parser.add_argument("--out", type=Path, default=FIXTURES_DIR)
    args = parser.parse_args()

    if not args.check:
        if args.out.exists():
            shutil.rmtree(args.out)
        build_fixtures(args.out)
        print(f"Wrote fixtures to {args.out}")
        return 0

    if not args.out.exists():
        print(f"No fixtures found at {args.out}; run scripts/generate_fixtures.py", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory() as tmp:
        candidate = Path(tmp) / "fixtures"
        build_fixtures(candidate)
        problems = compare_trees(args.out, candidate)

    if problems:
        print("Committed fixtures are out of date:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print(
            "\nRegenerate them with `npm run fixtures` and commit the result, or "
            "check whether a change under brother_ql/ altered the wire protocol.",
            file=sys.stderr,
        )
        return 1

    print(f"Fixtures are up to date ({args.out})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
