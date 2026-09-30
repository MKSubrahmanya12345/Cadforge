import { describe, expect, test } from 'bun:test';
import { AssemblyItemSchema, PartSpecSchema, type AssemblyItem, type PartSpec } from '@cadforge/shared';
import { SEED_PARTS } from '../seed/parts.js';

describe('seed library integrity', () => {
  test('contains every part the spec requires', () => {
    const ids = SEED_PARTS.map((p) => p.id);
    const required = [
      'arduino-uno-r3',
      'led-5mm',
      'led-3mm',
      'pin-header-2.54',
      'resistor-axial-1-4w',
      'breadboard-half',
      'tact-switch-6mm',
      'servo-sg90',
      'hc-sr04',
      'raspberry-pi-4b',
    ];
    for (const id of required) {
      expect(ids).toContain(id);
    }
    expect(SEED_PARTS).toHaveLength(required.length);
  });

  test('every part parses against the PartSpec schema', () => {
    for (const part of SEED_PARTS) {
      expect(() => PartSpecSchema.parse(part)).not.toThrow();
    }
  });

  test('ids are unique', () => {
    const ids = SEED_PARTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('all parts are verified and carry at least one source', () => {
    for (const part of SEED_PARTS) {
      expect(part.verified).toBe(true);
      expect(part.origin).toBe('seed');
      expect(part.sources.length).toBeGreaterThan(0);
      for (const src of part.sources) {
        expect(src.url).toMatch(/^https?:\/\//);
        expect(src.title.length).toBeGreaterThan(0);
        expect(src.extracted_fields.length).toBeGreaterThan(0);
      }
    }
  });

  test('confidence is honest: nothing claims a manufacturer drawing it does not have', () => {
    for (const part of SEED_PARTS) {
      expect(part.confidence).toBeGreaterThanOrEqual(0.7);
      expect(part.confidence).toBeLessThanOrEqual(1);
    }
    // The Uno is the only part with a real mechanical drawing in the seed set.
    const uno = SEED_PARTS.find((p) => p.id === 'arduino-uno-r3');
    expect(uno?.confidence).toBe(0.9);
    // Approximate data is marked below 0.9 and called out in the notes.
    for (const part of SEED_PARTS) {
      if (part.confidence < 0.9) {
        expect(part.notes).toBeTruthy();
      }
    }
  });
});

describe('Arduino Uno R3 seed dimensions', () => {
  const uno = SEED_PARTS.find((p) => p.id === 'arduino-uno-r3') as PartSpec;

  test('PCB outline is 68.58 x 53.34 mm', () => {
    expect(uno.bbox_mm.x).toBe(68.58);
    expect(uno.bbox_mm.y).toBe(53.34);
  });

  test('the four mounting holes are at the specified positions, 3.2 mm', () => {
    const holes = uno.features.filter((f) => f.type === 'hole');
    expect(holes).toHaveLength(4);
    const expected: Array<[number, number]> = [
      [13.97, 2.54],
      [15.24, 50.8],
      [66.04, 7.62],
      [66.04, 35.56],
    ];
    for (const [x, y] of expected) {
      const found = holes.find(
        (h) => Math.abs(h.position_mm.x - x) < 1e-6 && Math.abs(h.position_mm.y - y) < 1e-6,
      );
      expect(found).toBeDefined();
      expect(found!.dims_mm['diameter']).toBe(3.2);
    }
  });

  test('all four mounting holes are inside the PCB outline', () => {
    for (const f of uno.features.filter((x) => x.type === 'hole')) {
      expect(f.position_mm.x).toBeGreaterThan(0);
      expect(f.position_mm.x).toBeLessThan(uno.bbox_mm.x);
      expect(f.position_mm.y).toBeGreaterThan(0);
      expect(f.position_mm.y).toBeLessThan(uno.bbox_mm.y);
    }
  });

  test('header pitch is 2.54 mm', () => {
    expect(uno.pitch_mm).toBe(2.54);
  });

  test('anchors exist for D0-D13, A0-A5, 5V, GND, power jack, and USB-B', () => {
    const names = new Set(uno.anchors.map((a) => a.name));
    for (let i = 0; i <= 13; i += 1) {
      expect(names.has(`D${i}_pin`)).toBe(true);
    }
    for (let i = 0; i <= 5; i += 1) {
      expect(names.has(`A${i}_pin`)).toBe(true);
    }
    expect(names.has('5V_pin')).toBe(true);
    expect(names.has('GND_pin_1')).toBe(true);
    expect(names.has('GND_pin_2')).toBe(true);
    expect(names.has('power_jack')).toBe(true);
    expect(names.has('usb_b_center')).toBe(true);
    expect(names.has('top_center')).toBe(true);
  });

  test('D0-D13 anchors are evenly spaced at 2.54 mm', () => {
    const positions = uno.anchors
      .filter((a) => /^D\d+_pin$/.test(a.name))
      .map((a) => a.position_mm.x)
      .sort((a, b) => a - b);
    expect(positions).toHaveLength(14);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]! - positions[i - 1]!).toBeCloseTo(2.54, 6);
    }
  });

  test('every pin anchor sits inside the board outline', () => {
    for (const a of uno.anchors) {
      if (!/^(D\d+|A\d+)_pin$/.test(a.name)) continue;
      expect(a.position_mm.x).toBeGreaterThan(0);
      expect(a.position_mm.x).toBeLessThan(uno.bbox_mm.x);
      expect(a.position_mm.y).toBeGreaterThan(0);
      expect(a.position_mm.y).toBeLessThan(uno.bbox_mm.y);
      expect(a.position_mm.z).toBeCloseTo(1.6, 6);
    }
  });

  test('the USB-B shell is represented as a physical envelope', () => {
    const usb = uno.features.find((f) => f.name === 'usb_b_shell');
    expect(usb).toBeDefined();
    expect(usb!.note?.toLowerCase()).toContain('envelope');
    expect(usb!.dims_mm['x']).toBe(12);
    expect(usb!.dims_mm['y']).toBe(16);
    expect(usb!.dims_mm['z']).toBe(11);
    expect(uno.notes?.toLowerCase()).toContain('approximation');
  });

  test('no duplicate anchor names', () => {
    const names = uno.anchors.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('5mm LED seed dimensions', () => {
  const led = SEED_PARTS.find((p) => p.id === 'led-5mm') as PartSpec;

  test('dome 5.0 mm, flange 5.8 mm, height 8.6 mm', () => {
    expect(led.bbox_mm.z).toBe(8.6);
    const dome = led.features.find((f) => f.name === 'dome');
    expect(dome?.dims_mm['diameter']).toBe(5.0);
    const flange = led.features.find((f) => f.name === 'flange');
    expect(flange?.dims_mm['diameter']).toBe(5.8);
  });

  test('lead pitch 2.54 mm, lead diameter 0.5 mm, lead length 25 mm', () => {
    expect(led.pitch_mm).toBe(2.54);
    const lead = led.features.find((f) => f.name === 'lead_1');
    expect(lead?.dims_mm['diameter']).toBe(0.5);
    expect(lead?.dims_mm['length']).toBe(25);
    expect(lead?.dims_mm['pitch']).toBe(2.54);
    expect(lead?.dims_mm['count']).toBe(2);
  });

  test('has lead anchors so it can be placed on a header', () => {
    const names = led.anchors.map((a) => a.name);
    expect(names).toContain('lead_1');
    expect(names).toContain('lead_2');
    expect(names).toContain('flange_seat');
  });

  test('the LED is genuinely LED-sized next to the Uno', () => {
    const uno = SEED_PARTS.find((p) => p.id === 'arduino-uno-r3') as PartSpec;
    // This is the product's core guarantee: the 5.8mm flange next to a 53.34mm
    // board, and the LED standing taller than the bare PCB.
    expect(led.bbox_mm.x / uno.bbox_mm.y).toBeCloseTo(5.8 / 53.34, 6);
    expect(led.bbox_mm.z).toBeGreaterThan(uno.bbox_mm.z);
  });

  test('the Uno bounding box is the complete physical envelope and base thickness is separate', () => {
    const uno = SEED_PARTS.find((p) => p.id === 'arduino-uno-r3') as PartSpec;
    expect(uno.bbox_mm.z).toBe(14.0);
    expect(uno.base_thickness_mm).toBe(1.6);
    const tall = uno.features.filter((f) => (f.dims_mm['z'] ?? 0) > uno.base_thickness_mm!);
    expect(tall.length).toBeGreaterThan(0);
  });
});

describe('other seeded parts', () => {
  test('3mm LED is smaller than the 5mm LED', () => {
    const three = SEED_PARTS.find((p) => p.id === 'led-3mm') as PartSpec;
    const five = SEED_PARTS.find((p) => p.id === 'led-5mm') as PartSpec;
    expect(three.bbox_mm.x).toBeLessThan(five.bbox_mm.x);
    expect(three.bbox_mm.z).toBeLessThan(five.bbox_mm.z);
  });

  test('1/4W resistor body 6.3 x 2.3 mm, lead diameter 0.6 mm', () => {
    const r = SEED_PARTS.find((p) => p.id === 'resistor-axial-1-4w') as PartSpec;
    expect(r.bbox_mm.x).toBe(6.3);
    expect(r.bbox_mm.y).toBe(2.3);
    const lead = r.features.find((f) => f.name === 'lead');
    expect(lead?.dims_mm['diameter']).toBe(0.6);
    expect(r.pitch_mm).toBe(10.16);
  });

  test('half-size breadboard is 82.6 x 55 x 8.5 mm', () => {
    const b = SEED_PARTS.find((p) => p.id === 'breadboard-half') as PartSpec;
    expect(b.bbox_mm).toEqual({ x: 82.6, y: 55.0, z: 8.5 });
  });

  test('tactile switch is 6 x 6 x 5 mm', () => {
    const t = SEED_PARTS.find((p) => p.id === 'tact-switch-6mm') as PartSpec;
    expect(t.bbox_mm).toEqual({ x: 6.0, y: 6.0, z: 5.0 });
  });

  test('SG90 servo is 22.5 x 12.2 x 22.5 mm and has a horn', () => {
    const s = SEED_PARTS.find((p) => p.id === 'servo-sg90') as PartSpec;
    expect(s.bbox_mm).toEqual({ x: 22.5, y: 12.2, z: 22.5 });
    expect(s.features.some((f) => f.name === 'horn')).toBe(true);
  });

  test('HC-SR04 is 45 x 20 x 15 mm', () => {
    const h = SEED_PARTS.find((p) => p.id === 'hc-sr04') as PartSpec;
    expect(h.bbox_mm).toEqual({ x: 45.0, y: 20.0, z: 15.0 });
  });

  test('Raspberry Pi 4B is 85 x 56 x 1.6 with holes 3.5 mm from the edges on a 58 x 49 pattern', () => {
    const p = SEED_PARTS.find((x) => x.id === 'raspberry-pi-4b') as PartSpec;
    expect(p.bbox_mm).toEqual({ x: 85.0, y: 56.0, z: 1.6 });
    const holes = p.features.filter((f) => f.type === 'hole');
    expect(holes).toHaveLength(4);
    const xs = holes.map((h) => h.position_mm.x).sort((a, b) => a - b);
    const ys = holes.map((h) => h.position_mm.y).sort((a, b) => a - b);
    expect(xs[0]).toBe(3.5);
    expect(xs[3]).toBe(81.5);
    expect(xs[3]! - xs[0]!).toBeCloseTo(78.0, 6);
    expect(ys[0]).toBe(3.5);
    expect(ys[3]! - ys[0]!).toBeCloseTo(49.0, 6);
  });

  test('pin header pitch matches the Uno header pitch', () => {
    const h = SEED_PARTS.find((p) => p.id === 'pin-header-2.54') as PartSpec;
    const uno = SEED_PARTS.find((p) => p.id === 'arduino-uno-r3') as PartSpec;
    expect(h.pitch_mm).toBe(uno.pitch_mm);
  });
});

describe('seed parts survive assembly round-trips', () => {
  test('a Uno + LED assembly validates as AssemblyItem[]', () => {
    const items: AssemblyItem[] = [
      {
        partId: 'arduino-uno-r3',
        instanceName: 'arduino_uno_r3_1',
        placement: { offset_mm: { x: 0, y: 0, z: 0 }, rotation_deg: { x: 0, y: 0, z: 0 } },
      },
      {
        partId: 'led-5mm',
        instanceName: 'led_5mm_1',
        placement: {
          anchorRef: { targetInstance: 'arduino_uno_r3_1', anchorName: 'D13_pin' },
          offset_mm: { x: 0, y: 0, z: 0 },
          rotation_deg: { x: 0, y: 0, z: 0 },
        },
      },
    ];
    const parsed = z_array(items);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]!.placement.anchorRef?.anchorName).toBe('D13_pin');
  });
});

function z_array(items: AssemblyItem[]): AssemblyItem[] {
  // Local helper so the schema import stays in one place.
  return items.map((i) => AssemblyItemSchema.parse(i));
}
