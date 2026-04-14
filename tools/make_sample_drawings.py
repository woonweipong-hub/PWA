"""Generate two vector-PDF floor plans (V1 / V2) for the SiteShrimp compare demo.

Both drawings are original, license-free. V2 differs from V1 in a few targeted
spots (wall moved, door swapped, extra window, room label renamed) so the
compare feature has something meaningful to highlight.

Run:  python tools/make_sample_drawings.py
Output: sample_drwgs/SampleHouse_V1.pdf, sample_drwgs/SampleHouse_V2.pdf
"""
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A3
from reportlab.lib.units import mm
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "sample_drwgs")
os.makedirs(OUT_DIR, exist_ok=True)

PAGE_W, PAGE_H = A3  # landscape-friendly wide format


def titleblock(c, title, rev, date):
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(0.6)
    x, y, w, h = 25 * mm, 15 * mm, PAGE_W - 50 * mm, 22 * mm
    c.rect(x, y, w, h)
    c.line(x + w * 0.55, y, x + w * 0.55, y + h)
    c.line(x + w * 0.80, y, x + w * 0.80, y + h)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(x + 6 * mm, y + h - 9 * mm, title)
    c.setFont("Helvetica", 9)
    c.drawString(x + 6 * mm, y + 5 * mm,
                 "Sample — Public-domain demo drawing for SiteShrimp")
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x + w * 0.55 + 4 * mm, y + h - 8 * mm, f"REV  {rev}")
    c.setFont("Helvetica", 9)
    c.drawString(x + w * 0.55 + 4 * mm, y + h - 14 * mm, f"Date: {date}")
    c.drawString(x + w * 0.55 + 4 * mm, y + 5 * mm, "Scale: 1:100 @ A3")
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x + w * 0.80 + 4 * mm, y + h - 8 * mm, "SITESHRIMP")
    c.setFont("Helvetica", 8)
    c.drawString(x + w * 0.80 + 4 * mm, y + h - 14 * mm, "Demo Pack 01")


def draw_wall(c, x1, y1, x2, y2, thickness=3):
    c.setLineWidth(thickness)
    c.setStrokeColorRGB(0, 0, 0)
    c.line(x1, y1, x2, y2)


def draw_door(c, x, y, size=8 * mm, direction="right"):
    # Door arc + leaf
    c.setLineWidth(0.4)
    c.setStrokeColorRGB(0.35, 0.35, 0.35)
    if direction == "right":
        c.arc(x, y, x + size, y + size, startAng=0, extent=90)
        c.line(x, y, x + size, y)
    else:
        c.arc(x - size, y, x, y + size, startAng=90, extent=90)
        c.line(x, y, x - size, y)


def draw_window(c, x1, y1, x2, y2):
    c.setLineWidth(0.8)
    c.setStrokeColorRGB(0.0, 0.35, 0.85)
    c.line(x1, y1, x2, y2)
    # inner mullion
    mid_x, mid_y = (x1 + x2) / 2, (y1 + y2) / 2
    c.setLineWidth(0.3)
    c.circle(mid_x, mid_y, 1.2 * mm, stroke=1, fill=0)


def room_label(c, cx, cy, name, area_m2):
    c.setFillColorRGB(0, 0, 0)
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(cx, cy + 2 * mm, name)
    c.setFont("Helvetica", 8)
    c.drawCentredString(cx, cy - 3 * mm, f"{area_m2:.1f} m²")


def dimension(c, x1, y1, x2, y2, text, offset=6 * mm):
    # Horizontal dimension line above
    c.setStrokeColorRGB(0.3, 0.3, 0.3)
    c.setLineWidth(0.3)
    c.line(x1, y1 + offset, x2, y1 + offset)
    c.line(x1, y1, x1, y1 + offset + 1 * mm)
    c.line(x2, y2, x2, y2 + offset + 1 * mm)
    c.setFont("Helvetica", 7)
    c.setFillColorRGB(0.2, 0.2, 0.2)
    c.drawCentredString((x1 + x2) / 2, y1 + offset + 1.5 * mm, text)


def draw_plan(c, version):
    """version in {'V1','V2'}."""
    # Outer envelope (all dimensions in mm from bottom-left of page)
    ox, oy = 40 * mm, 55 * mm
    W, H = 220 * mm, 150 * mm

    # Exterior walls (thicker)
    draw_wall(c, ox, oy, ox + W, oy, 4)
    draw_wall(c, ox + W, oy, ox + W, oy + H, 4)
    draw_wall(c, ox + W, oy + H, ox, oy + H, 4)
    draw_wall(c, ox, oy + H, ox, oy, 4)

    # Interior layout — 3 rooms + corridor + bathroom
    # Vertical split: left half = living+kitchen, right half = bedrooms
    split_x = ox + W * 0.55 if version == "V1" else ox + W * 0.60
    draw_wall(c, split_x, oy, split_x, oy + H, 2.5)

    # Horizontal split on the right
    right_split_y = oy + H * 0.50
    draw_wall(c, split_x, right_split_y, ox + W, right_split_y, 2.5)

    # Kitchen partition on the left (top portion)
    left_kitchen_y = oy + H * 0.62
    draw_wall(c, ox, left_kitchen_y, split_x, left_kitchen_y, 2.5)

    # Bathroom — small room at the bottom right
    bath_x1 = split_x
    bath_x2 = split_x + (W - (split_x - ox)) * 0.45
    bath_y2 = oy + H * 0.25
    draw_wall(c, bath_x1, bath_y2, bath_x2, bath_y2, 2)
    draw_wall(c, bath_x2, oy, bath_x2, bath_y2, 2)

    # Doors
    if version == "V1":
        draw_door(c, ox + W * 0.20, oy, 10 * mm, "right")           # main entry (living)
        draw_door(c, split_x - 12 * mm, left_kitchen_y, 10 * mm, "right")  # kitchen
        draw_door(c, split_x + 2 * mm, right_split_y - 12 * mm, 10 * mm)   # bedroom1
        draw_door(c, split_x + 2 * mm, right_split_y + 2 * mm, 10 * mm)    # bedroom2
    else:
        # V2 changes: main entry shifted; bathroom door relocated; added 2nd entry
        draw_door(c, ox + W * 0.30, oy, 10 * mm, "right")
        draw_door(c, split_x - 12 * mm, left_kitchen_y, 10 * mm, "right")
        draw_door(c, split_x + 2 * mm, right_split_y - 12 * mm, 10 * mm)
        draw_door(c, split_x + 2 * mm, right_split_y + 2 * mm, 10 * mm)
        draw_door(c, bath_x2 - 10 * mm, bath_y2, 8 * mm, "right")   # NEW bathroom door

    # Windows
    # Living room front
    draw_window(c, ox + 30 * mm, oy + H, ox + 60 * mm, oy + H)
    # Kitchen side
    draw_window(c, ox, left_kitchen_y + 20 * mm, ox, left_kitchen_y + 45 * mm)
    # Bedroom1 (bottom-right)
    draw_window(c, ox + W * 0.75, oy, ox + W * 0.92, oy)
    # Bedroom2 (top-right)
    draw_window(c, ox + W, oy + H * 0.65, ox + W, oy + H * 0.85)
    if version == "V2":
        # V2: extra window in the kitchen rear
        draw_window(c, ox + 6 * mm, oy + H, ox + 22 * mm, oy + H)

    # Room labels
    # Living
    room_label(c, (ox + split_x) / 2, oy + H * 0.32,
               "LIVING" if version == "V1" else "LIVING / DINING", 28.5)
    # Kitchen
    room_label(c, (ox + split_x) / 2, (left_kitchen_y + oy + H) / 2,
               "KITCHEN", 10.4)
    # Bedroom 1
    room_label(c, (bath_x2 + ox + W) / 2, (oy + right_split_y) / 2,
               "BEDROOM 1", 12.6)
    # Bathroom
    room_label(c, (split_x + bath_x2) / 2, (oy + bath_y2) / 2,
               "BATH", 4.2)
    # Bedroom 2
    room_label(c, (split_x + ox + W) / 2, (right_split_y + oy + H) / 2,
               "BEDROOM 2" if version == "V1" else "MASTER BEDROOM", 15.8)

    # Dimensions across top
    dimension(c, ox, oy + H, ox + W, oy + H,
              f"{int(W/mm)*10} mm overall", offset=10 * mm)

    # North arrow
    nx, ny = ox + W - 15 * mm, oy + H - 15 * mm
    c.setFillColorRGB(0, 0, 0)
    c.setLineWidth(0.4)
    c.circle(nx, ny, 6 * mm, stroke=1, fill=0)
    from reportlab.graphics.shapes import Polygon
    # Triangle arrow
    c.line(nx, ny - 5 * mm, nx, ny + 5 * mm)
    c.line(nx, ny + 5 * mm, nx - 2 * mm, ny + 1 * mm)
    c.line(nx, ny + 5 * mm, nx + 2 * mm, ny + 1 * mm)
    c.setFont("Helvetica-Bold", 7)
    c.drawCentredString(nx, ny + 7 * mm, "N")

    # Revision cloud on V2 (visually marks the revised area)
    if version == "V2":
        c.saveState()
        c.setStrokeColorRGB(0.85, 0.1, 0.1)
        c.setLineWidth(0.8)
        c.setDash(3, 3)
        c.rect(split_x - 8 * mm, oy - 4 * mm, (ox + W) - split_x + 12 * mm,
               H * 0.30, stroke=1, fill=0)
        c.setFillColorRGB(0.85, 0.1, 0.1)
        c.setFont("Helvetica-Bold", 9)
        c.drawString(split_x - 6 * mm, oy - 10 * mm,
                     "REV B — bathroom door + layout update")
        c.restoreState()


def make_pdf(path, version, date):
    c = canvas.Canvas(path, pagesize=A3)
    c.setTitle(f"SiteShrimp Sample Plan — {version}")
    c.setAuthor("SiteShrimp demo generator")
    draw_plan(c, version)
    titleblock(c, f"SAMPLE HOUSE — GROUND FLOOR ({version})", version, date)
    c.showPage()
    c.save()
    print(f"wrote {path}")


if __name__ == "__main__":
    make_pdf(os.path.join(OUT_DIR, "SampleHouse_V1.pdf"), "V1", "2026-03-14")
    make_pdf(os.path.join(OUT_DIR, "SampleHouse_V2.pdf"), "V2", "2026-04-14")
