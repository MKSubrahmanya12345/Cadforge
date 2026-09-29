"""Arduino Uno R3 visual engineering model, dimensions in millimetres.

The PCB envelope and four mounting-hole centres are taken from Arduino's
Uno R3 mechanical drawing. Component envelopes and placements are visual
approximations. The model is intended for CAD visualization, not fabrication.

Run with CadQuery 2.x, for example:
    conda run -n cq python models/arduino_uno_r3.py

Writes a colored STEP assembly and STL/GLB visualization files beside this file.
"""

from __future__ import annotations

from pathlib import Path

import cadquery as cq


BOARD_W = 68.58
BOARD_H = 53.34
BOARD_T = 1.60
BOARD_X = 11.50  # leaves room for the USB-B shell at the left edge
BOARD_COLOR = "#087f5b"
DRAWING_URL = "https://content.arduino.cc/assets/av0-0011/Uno-R3-MECHANICAL.pdf"
HOLES = ((13.97, 2.54), (15.24, 50.80), (66.04, 7.62), (66.04, 35.56))


def rounded_box(x: float, y: float, z: float, radius: float = 0.4) -> cq.Workplane:
    """A lower-left-origin box with its vertical corners rounded."""
    body = cq.Workplane("XY").box(x, y, z, centered=(False, False, False))
    if radius > 0:
        body = body.edges("|Z").fillet(min(radius, x / 3, y / 3))
    return body


def compound(shapes: list[cq.Workplane | cq.Shape]) -> cq.Shape:
    solids = [shape.val() if isinstance(shape, cq.Workplane) else shape for shape in shapes]
    return cq.Compound.makeCompound(solids)


def pcb() -> cq.Workplane:
    board = rounded_box(BOARD_W, BOARD_H, BOARD_T, 2.0)
    for x, y in HOLES:
        cutter = cq.Workplane("XY").center(x, y).circle(1.6).extrude(BOARD_T + 0.2)
        board = board.cut(cutter.translate((0, 0, -0.1)))
    return board


def usb_b_shell() -> cq.Workplane:
    shell = rounded_box(12.0, 16.0, 11.0, 1.0)
    # Recessed mouth and a deep socket cavity, both cut from the outward face.
    mouth = cq.Workplane("YZ").center(8.0, 5.5).rect(8.2, 6.2).extrude(1.2)
    cavity = cq.Workplane("YZ").center(8.0, 5.5).rect(6.8, 4.8).extrude(7.0)
    return shell.cut(mouth).cut(cavity)


def barrel_jack() -> cq.Workplane:
    shell = rounded_box(10.0, 10.0, 11.0, 1.2)
    # Counterbore on the connector face, with a smaller inner bore.
    counterbore = cq.Workplane("YZ").center(5.0, 5.4).circle(3.2).extrude(1.0)
    bore = cq.Workplane("YZ").center(5.0, 5.4).circle(2.1).extrude(6.5)
    return shell.cut(counterbore).cut(bore)


def dip28_package() -> cq.Shape:
    pieces: list[cq.Workplane | cq.Shape] = [
        rounded_box(17.8, 7.6, 3.8, 0.35).translate((0, 1.0, 0.6)),
        # DIP notch at pin 1 end.
        cq.Workplane("XY").center(1.0, 4.8).circle(0.65).extrude(0.3).translate((0, 0, 4.1)),
    ]
    for index in range(14):
        x = 0.635 + 1.27 * index
        pieces.append(cq.Workplane("XY").box(0.45, 1.0, 0.55, centered=(True, False, False)).translate((x, 0, 0.05)))
        pieces.append(cq.Workplane("XY").box(0.45, 1.0, 0.55, centered=(True, False, False)).translate((x, 8.6, 0.05)))
    return compound(pieces)


def female_header(pins: int, rows: int = 1) -> cq.Shape:
    """Black socket strip with a repeated socket pattern and square tails."""
    width = pins * 2.54
    height = rows * 2.54
    pieces: list[cq.Workplane | cq.Shape] = [
        cq.Workplane("XY").box(width, height, 2.4, centered=(False, False, False)).translate((0, 0, 3.0))
    ]
    for row in range(rows):
        for col in range(pins):
            x = 1.27 + col * 2.54
            y = 1.27 + row * 2.54
            recess = cq.Workplane("XY").center(x, y).circle(0.72).extrude(0.65).translate((0, 0, 4.8))
            # Recesses are cut into the shared black housing after the pins are made.
            pieces.append(cq.Workplane("XY").box(0.55, 0.55, 5.4, centered=(True, True, False)).translate((x, y, 0)))
    housing = pieces[0]
    for row in range(rows):
        for col in range(pins):
            x = 1.27 + col * 2.54
            y = 1.27 + row * 2.54
            housing = housing.cut(cq.Workplane("XY").center(x, y).circle(0.72).extrude(0.65).translate((0, 0, 4.8)))
    return compound([housing, *pieces[1:]])


def split_lower_headers() -> cq.Shape:
    # Power (8 positions including NC) and analog (6 positions), with the
    # small gap preserved between the two socket strips.
    first = female_header(6)
    second = female_header(6).translate((17.78, 0, 0))
    return compound([first, second])


def icsp_header() -> cq.Shape:
    return female_header(3, 2)


def regulator() -> cq.Shape:
    tab = cq.Workplane("XY").box(10.0, 6.0, 0.65, centered=(False, False, False))
    tab_hole = cq.Workplane("XY").center(5.0, 3.0).circle(1.45).extrude(0.85).translate((0, 0, -0.1))
    body = rounded_box(4.8, 7.0, 4.5, 0.6).translate((2.6, 5.0, 0))
    leads = [cq.Workplane("XY").box(0.7, 0.8, 0.45, centered=(False, False, False)).translate((x, 14.2, 0)) for x in (3.0, 5.0, 7.0)]
    return compound([tab.cut(tab_hole), body, *leads])


def usb_interface_ic() -> cq.Shape:
    pieces: list[cq.Workplane | cq.Shape] = [rounded_box(6.0, 6.0, 1.5, 0.45).translate((0.5, 0.5, 0.0))]
    # Fine gull-wing leads along four sides, simplified as metal tabs.
    for i in range(8):
        p = 0.8 + i * 0.8
        pieces.append(cq.Workplane("XY").box(0.55, 0.35, 0.4, centered=(True, False, False)).translate((p, 0.0, 0.15)))
        pieces.append(cq.Workplane("XY").box(0.55, 0.35, 0.4, centered=(True, False, False)).translate((p, 6.65, 0.15)))
        pieces.append(cq.Workplane("XY").box(0.35, 0.55, 0.4, centered=(False, True, False)).translate((0.0, p, 0.15)))
        pieces.append(cq.Workplane("XY").box(0.35, 0.55, 0.4, centered=(False, True, False)).translate((6.65, p, 0.15)))
    return compound(pieces)


def reset_switch() -> cq.Shape:
    base = rounded_box(6.0, 6.0, 2.0, 0.5)
    actuator = cq.Workplane("XY").circle(1.65).extrude(1.2).translate((3.0, 3.0, 2.0))
    cap = cq.Workplane("XY").sphere(1.65).translate((3.0, 3.0, 2.75))
    cap_clip = cq.Workplane("XY").box(3.3, 3.3, 0.45, centered=(False, False, False)).translate((1.35, 1.35, 2.75))
    return compound([base, actuator, cap.intersect(cap_clip)])


def crystal() -> cq.Workplane:
    return rounded_box(3.2, 2.5, 1.2, 0.35)


def led_lens() -> cq.Shape:
    """3 mm indicator LED: round barrel and a true hemispherical lens dome."""
    diameter = 3.0
    radius = diameter / 2
    barrel_height = 0.8
    barrel = cq.Workplane("XY").circle(radius).extrude(barrel_height).translate((radius, radius, 0))
    sphere = cq.Workplane("XY").sphere(radius).translate((radius, radius, barrel_height))
    upper_half = cq.Workplane("XY").box(diameter, diameter, radius, centered=(False, False, False)).translate((0, 0, barrel_height))
    dome = sphere.intersect(upper_half)
    return compound([barrel, dome])


def capacitor_bank() -> cq.Shape:
    pieces: list[cq.Workplane | cq.Shape] = []
    for x, diameter, height in ((0.0, 4.0, 4.0), (5.0, 3.0, 3.2), (9.0, 2.0, 2.0)):
        body = cq.Workplane("XY").center(x + diameter / 2, 3.0).circle(diameter / 2).extrude(height)
        pieces.append(body)
        pieces.append(cq.Workplane("XY").box(0.25, 0.8, 1.2, centered=(True, True, False)).translate((x + diameter / 2 - 0.4, 3.0, -1.2)))
        pieces.append(cq.Workplane("XY").box(0.25, 0.8, 1.2, centered=(True, True, False)).translate((x + diameter / 2 + 0.4, 3.0, -1.2)))
    return compound(pieces)


def resistor_bank() -> cq.Shape:
    pieces: list[cq.Workplane | cq.Shape] = []
    for i in range(4):
        x = i * 4.0
        body = cq.Workplane("YZ").center(1.0, 0.65).circle(0.65).extrude(2.1).translate((x + 0.95, 0, 0))
        lead_l = cq.Workplane("XY").box(1.0, 0.25, 0.25, centered=(False, True, True)).translate((x, 1.0, 0.65))
        lead_r = cq.Workplane("XY").box(1.0, 0.25, 0.25, centered=(False, True, True)).translate((x + 3.0, 1.0, 0.65))
        pieces.extend([body, lead_l, lead_r])
    return compound(pieces)


def part_specs() -> list[dict]:
    """Local solids with assembly positions, exact nominal boxes, and colors."""
    return [
        {"id": "uno-pcb", "name": "Arduino Uno R3 PCB", "category": "board", "bbox": (BOARD_W, BOARD_H, BOARD_T), "position": (BOARD_X, 0, 0), "color": BOARD_COLOR, "shape": pcb()},
        {"id": "usb-b-connector", "name": "USB-B connector", "category": "connector", "bbox": (12.0, 16.0, 11.0), "position": (0, 17.5, 1.6), "color": "#c5c8ca", "shape": usb_b_shell()},
        {"id": "barrel-power-jack", "name": "DC barrel power jack", "category": "connector", "bbox": (10.0, 10.0, 11.0), "position": (2.0, 42.0, 1.6), "color": "#242424", "shape": barrel_jack()},
        {"id": "atmega328p-dip28", "name": "ATmega328P DIP-28 package", "category": "ic", "bbox": (17.8, 9.6, 4.4), "position": (28.54, 22.86, 1.6), "color": "#151515", "shape": dip28_package()},
        {"id": "digital-header-d0-d7", "name": "Digital socket header D0-D7", "category": "header", "bbox": (20.32, 2.54, 5.4), "position": (38.17, 47.0, -3.0), "color": "#181818", "shape": female_header(8)},
        {"id": "digital-header-d8-d13", "name": "Digital socket header D8-D13", "category": "header", "bbox": (15.24, 2.54, 5.4), "position": (59.125, 47.0, -3.0), "color": "#181818", "shape": female_header(6)},
        {"id": "power-analog-headers", "name": "Power and analog socket headers", "category": "header", "bbox": (33.02, 2.54, 5.4), "position": (38.17, 2.54, -3.0), "color": "#181818", "shape": split_lower_headers()},
        {"id": "icsp-header", "name": "ICSP 2x3 socket header", "category": "header", "bbox": (7.62, 5.08, 5.4), "position": (54.0, 39.0, -3.0), "color": "#181818", "shape": icsp_header()},
        {"id": "voltage-regulator", "name": "Voltage regulator with tab", "category": "ic", "bbox": (10.0, 15.0, 4.5), "position": (16.5, 5.0, 1.6), "color": "#252525", "shape": regulator()},
        {"id": "usb-interface-ic", "name": "USB interface IC with gull-wing leads", "category": "ic", "bbox": (7.0, 7.0, 1.5), "position": (59.5, 35.0, 1.6), "color": "#202020", "shape": usb_interface_ic()},
        {"id": "reset-switch", "name": "Reset tactile switch", "category": "other", "bbox": (6.0, 6.0, 3.65), "position": (26.5, 39.0, 1.6), "color": "#343434", "shape": reset_switch()},
        {"id": "crystal-oscillator", "name": "Crystal oscillator", "category": "other", "bbox": (3.2, 2.5, 1.2), "position": (51.5, 37.0, 1.6), "color": "#bbc0c5", "shape": crystal()},
        {"id": "led-power", "name": "Power LED with hemispherical lens", "category": "led", "bbox": (3.0, 3.0, 2.3), "position": (69.5, 17.0, 1.6), "color": "#30c85a", "shape": led_lens()},
        {"id": "led-tx", "name": "TX LED with hemispherical lens", "category": "led", "bbox": (3.0, 3.0, 2.3), "position": (69.5, 22.0, 1.6), "color": "#e6aa2e", "shape": led_lens()},
        {"id": "led-rx", "name": "RX LED with hemispherical lens", "category": "led", "bbox": (3.0, 3.0, 2.3), "position": (69.5, 27.0, 1.6), "color": "#e6aa2e", "shape": led_lens()},
        {"id": "capacitor-bank", "name": "Electrolytic and ceramic capacitor bank", "category": "capacitor", "bbox": (12.0, 6.0, 4.0), "position": (49.0, 5.0, 1.6), "color": "#3a3a3a", "shape": capacitor_bank()},
        {"id": "resistor-bank", "name": "SMD resistor bank", "category": "resistor", "bbox": (16.0, 2.0, 1.3), "position": (48.0, 18.0, 1.6), "color": "#c9a878", "shape": resistor_bank()},
    ]


def part_for_export(part_id: str) -> cq.Shape:
    for item in part_specs():
        if item["id"] == part_id:
            shape = item["shape"]
            return shape.val() if isinstance(shape, cq.Workplane) else shape
    raise KeyError(part_id)


def build_assembly() -> cq.Assembly:
    assembly = cq.Assembly(name="Arduino Uno R3")
    for item in part_specs():
        x, y, z = item["position"]
        shape = item["shape"]
        assembly.add(
            shape,
            loc=cq.Location(cq.Vector(x, y, z)),
            name=item["id"],
            color=cq.Color(item["color"]),
        )
    return assembly


def build() -> cq.Shape:
    """Return a single compound for CADQuery exporters that expect a Shape."""
    solids = []
    for item in part_specs():
        shape = item["shape"].val() if isinstance(item["shape"], cq.Workplane) else item["shape"]
        x, y, z = item["position"]
        solids.append(shape.translate(cq.Vector(x, y, z)))
    return cq.Compound.makeCompound(solids)


def main() -> None:
    output = Path(__file__).resolve().parent
    assembly = build_assembly()
    assembly.export(str(output / "arduino_uno_r3.step"))
    assembly.export(str(output / "arduino_uno_r3.glb"))
    cq.exporters.export(build(), str(output / "arduino_uno_r3.stl"))


if __name__ == "__main__":
    main()
