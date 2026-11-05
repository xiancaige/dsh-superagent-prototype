"""Harness-owned image inspector, used only by phase B visual-evidence tests and manual verification.

It reads the frames listed in the request and judges each check from what it can actually see:

* ``nonblank`` requires real spatial variation in the decoded pixels;
* ``readable`` requires a plausible capture size;
* ``pixel:<hex>`` requires enough pixels of that colour in one frame.

A check it cannot evaluate is reported as ``undetermined``; it never reports a pass it did not
observe. It writes the structured report the host adapter requires and exits non-zero without one
when the request is unusable. Pillow is required: without an image stack the inspector refuses, so a
missing decoder can never look like a pass.

Usage: python visual_inspector.py <request.json> <report.json>
"""
import json
import sys
from collections import Counter


def load(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def image_stats(path):
    from PIL import Image

    with Image.open(path) as image:
        image.load()
        rgb = image.convert("RGB")
        width, height = rgb.size
        colours = Counter()
        previous = None
        changes = 0
        pixels = getattr(rgb, "get_flattened_data", rgb.getdata)()
        for pixel in pixels:
            colours[pixel] += 1
            if previous is not None and pixel != previous:
                changes += 1
            previous = pixel
    return {"width": width, "height": height, "changes": changes, "colours": colours}


def judge(check, frames):
    stats = []
    for frame in frames:
        try:
            stats.append((frame, image_stats(frame)))
        except Exception as error:  # an unreadable frame is undetermined, never a pass
            return "undetermined", "%s could not be read: %s" % (frame, error), [frame]
    if not stats:
        return "undetermined", "no frame was provided", []
    every = [frame for frame, _ in stats]
    if check == "nonblank":
        variation = max(item["changes"] for _, item in stats)
        return ("passed" if variation >= 1000 else "failed"), "maximum pixel transitions %d" % variation, every
    if check == "readable":
        small = [(frame, item) for frame, item in stats if item["width"] < 64 or item["height"] < 64]
        if small:
            frame, item = small[0]
            return "failed", "%s is only %dx%d" % (frame, item["width"], item["height"]), [frame]
        return "passed", "every frame is at least 64x64", every
    if check.startswith("pixel:"):
        code = check.split(":", 1)[1]
        wanted = tuple(int(code[index:index + 2], 16) for index in (0, 2, 4))
        for frame, item in stats:
            count = item["colours"].get(wanted, 0)
            if count >= 100:
                return "passed", "%d pixels of %s in %s" % (count, code, frame), [frame]
        return "failed", "no frame holds enough %s pixels" % code, every
    return "undetermined", "inspector does not know the check %r" % check, every


def main(argv):
    # Optional clean environment for the interpreter: `-- <json object>` restores exactly these
    # variables, so a loader injected by the process that started this host cannot leak in.
    if len(argv) >= 3 and argv[1] == "--":
        import os
        os.environ.clear()
        os.environ.update(json.loads(argv[2]))
        argv = [argv[0]] + argv[3:]
    if len(argv) != 3:
        sys.exit(2)
    request = load(argv[1])
    groups = []
    for group in request.get("groups", []):
        checks = []
        for check in request.get("checks", []):
            verdict, reason, frames = judge(check, group.get("frames", []))
            checks.append({"check": check, "verdict": verdict, "reason": reason, "frames": frames})
        verdicts = set(item["verdict"] for item in checks)
        if "failed" in verdicts:
            group_verdict = "failed"
        elif verdicts == {"passed"}:
            group_verdict = "passed"
        else:
            group_verdict = "undetermined"
        first = next((item for item in checks if item["verdict"] == group_verdict), None)
        groups.append({"group": group.get("group"), "verdict": group_verdict,
                       "reason": first["reason"] if first else "no check judged", "checks": checks})
    with open(argv[2], "w", encoding="utf-8") as handle:
        json.dump({"groups": groups}, handle)


if __name__ == "__main__":
    main(sys.argv)
