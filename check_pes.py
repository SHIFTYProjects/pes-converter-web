"""Pre-flight safety check for a PES file. Usage: python check_pes.py file.pes [hoop_w_mm hoop_h_mm]

Requires: pip install pyembroidery
Reads the file the way a machine does (PEC stitch block) and reports anything likely to
jam, break thread or sew in place. Exit code 1 means DO NOT SEW.
"""
import sys
from collections import Counter

from pyembroidery import EmbPattern, STITCH, JUMP, TRIM, COLOR_CHANGE, END


def check(path, hoop_mm=(130, 180)):
    problems, notes = [], []
    pattern = EmbPattern.read_pes(path)
    cmds = pattern.stitches
    if not cmds:
        return ["File contains no stitches."], notes
    counts = Counter(c[2] for c in cmds)
    notes.append("commands: %d stitches, %d jumps, %d trims, %d color changes, %d threads" % (
        counts[STITCH], counts[JUMP], counts[TRIM], counts[COLOR_CHANGE], len(pattern.threadlist)))
    x0, y0, x1, y1 = pattern.bounds()
    notes.append("size: %.1f x %.1f mm, extent x %.1f..%.1f  y %.1f..%.1f mm" % (
        (x1 - x0) / 10, (y1 - y0) / 10, x0 / 10, x1 / 10, y0 / 10, y1 / 10))

    if cmds[0][2] != JUMP:
        problems.append("File does not start with a jump to the first stitch.")
    if cmds[-1][2] != END:
        problems.append("File does not end with END.")

    still = longest_still = 0
    max_step = 0
    for i in range(1, len(cmds)):
        if cmds[i][2] != STITCH:
            still = 0
            continue
        step = ((cmds[i][0] - cmds[i - 1][0]) ** 2 + (cmds[i][1] - cmds[i - 1][1]) ** 2) ** 0.5
        max_step = max(max_step, step)
        still = still + 1 if step == 0 else 0
        longest_still = max(longest_still, still)
        if step > 121:
            problems.append("Stitch %d is %.1f mm long (limit 12.1 mm)." % (i, step / 10))
        if still > 3:
            problems.append("Command %d: %d stitches in a row at the same point (thread-break risk)." % (i, still))
    notes.append("longest stitch %.1f mm, longest run in one spot %d" % (max_step / 10, longest_still))

    # Many trims relative to stitches usually means rows are not chained into a continuous fill.
    if counts[STITCH] and counts[TRIM] > max(3, counts[STITCH] / 60):
        problems.append("%d trims for %d stitches - rows are probably not chained (thread is cut too often)." % (
            counts[TRIM], counts[STITCH]))

    # The machine places the stream origin at the hoop centre unless the file says otherwise.
    for lo, hi, size, axis in ((x0, x1, hoop_mm[0], "X"), (y0, y1, hoop_mm[1], "Y")):
        if hi - lo > size * 10:
            problems.append("Design is wider than the hoop on the %s axis." % axis)
    return problems, notes


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    hoop = (float(sys.argv[2]), float(sys.argv[3])) if len(sys.argv) >= 4 else (130, 180)
    problems, notes = check(sys.argv[1], hoop)
    for n in notes:
        print(" ", n)
    if problems:
        print("DO NOT SEW:")
        for p in problems:
            print("  -", p)
        sys.exit(1)
    print("PASS: no structural problems found (still test on scrap fabric).")
