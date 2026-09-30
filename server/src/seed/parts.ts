import type { PartSpec } from '@cadforge/shared';
import { PartSpecSchema, type Feature, type Source } from '@cadforge/shared';

const UNO_D = 'https://docs.arduino.cc/hardware/uno-rev3/';
const UNO_MECH = 'https://content.arduino.cc/assets/av0-0011/Uno-R3-MECHANICAL.pdf';

function hole(name: string, x: number, y: number, diameter: number, note?: string): Feature {
  return { type: 'hole', name, position_mm: { x, y, z: 0 }, dims_mm: { diameter, depth: 1.6 }, ...(note ? { note } : {}) };
}

function anchor(name: string, x: number, y: number, z = 0, normal?: { x: number; y: number; z: number }) {
  return { name, position_mm: { x, y, z }, ...(normal ? { normal } : {}) };
}

function source(url: string, title: string, extracted_fields: Source['extracted_fields']): Source {
  return { url, title, extracted_fields };
}

// -----------------------------------------------------------------------------
// Arduino Uno R3
// -----------------------------------------------------------------------------

/** Digital header D0-D13: 2.54 mm pitch, top edge. */
const UNO_DIGITAL_PITCH = 2.54;
const UNO_DIGITAL_X0 = 26.67;
const UNO_DIGITAL_Y = 48.26;
const UNO_ANALOG_X0 = 26.67;
const UNO_ANALOG_Y = 5.08;

function unoDigitalAnchors(): Array<ReturnType<typeof anchor>> {
  const out = [];
  for (let i = 0; i <= 13; i += 1) {
    out.push(anchor(`D${i}_pin`, UNO_DIGITAL_X0 + i * UNO_DIGITAL_PITCH, UNO_DIGITAL_Y, 1.6, { x: 0, y: 0, z: 1 }));
  }
  out.push(anchor('5V_pin', UNO_DIGITAL_X0 + 14 * UNO_DIGITAL_PITCH, UNO_DIGITAL_Y, 1.6, { x: 0, y: 0, z: 1 }));
  out.push(anchor('GND_pin_1', UNO_DIGITAL_X0 + 15 * UNO_DIGITAL_PITCH, UNO_DIGITAL_Y, 1.6, { x: 0, y: 0, z: 1 }));
  out.push(anchor('GND_pin_2', UNO_DIGITAL_X0 + 16 * UNO_DIGITAL_PITCH, UNO_DIGITAL_Y, 1.6, { x: 0, y: 0, z: 1 }));
  out.push(anchor('RESET_pin', UNO_DIGITAL_X0 + 17 * UNO_DIGITAL_PITCH, UNO_DIGITAL_Y, 1.6, { x: 0, y: 0, z: 1 }));
  out.push(anchor('AREF_pin', UNO_DIGITAL_X0 + 18 * UNO_DIGITAL_PITCH, UNO_DIGITAL_Y, 1.6, { x: 0, y: 0, z: 1 }));
  out.push(anchor('3V3_pin', UNO_DIGITAL_X0 + 19 * UNO_DIGITAL_PITCH, UNO_DIGITAL_Y, 1.6, { x: 0, y: 0, z: 1 }));
  return out;
}

function unoAnalogAnchors(): Array<ReturnType<typeof anchor>> {
  const out = [];
  for (let i = 0; i <= 5; i += 1) {
    out.push(anchor(`A${i}_pin`, UNO_ANALOG_X0 + i * UNO_DIGITAL_PITCH, UNO_ANALOG_Y, 1.6, { x: 0, y: 0, z: 1 }));
  }
  return out;
}

const uno: PartSpec = PartSpecSchema.parse({
  id: 'arduino-uno-r3',
  name: 'Arduino Uno R3',
  category: 'board',
  aliases: ['uno', 'arduino uno', 'uno r3', 'arduino uno r3', 'arduino'],
  // bbox_mm is the complete physical envelope of the board assembly. The PCB
  // itself remains 1.6 mm thick via base_thickness_mm; mounted hardware occupies
  // the remaining Z envelope.
  bbox_mm: { x: 68.58, y: 53.34, z: 12.6 },
  base_thickness_mm: 1.6,
  // Official Uno R3 PCB outline, transcribed from the mechanical drawing.
  // Coordinates are measured from the lower-left PCB datum; the connector
  // overhangs remain outside this base profile and are modeled separately.
  profile_mm: [
    { x: 0, y: 0 },
    { x: 0, y: 53.34 },
    { x: 64.516, y: 53.34 },
    { x: 66.04, y: 51.816 },
    { x: 66.04, y: 40.386 },
    { x: 68.58, y: 37.846 },
    { x: 68.58, y: 5.08 },
    { x: 66.04, y: 2.54 },
    { x: 66.04, y: 0 },
  ],
  pitch_mm: UNO_DIGITAL_PITCH,
  material: 'FR-4 PCB',
  color_hex: '#0f9d58',
  confidence: 0.9,
  verified: true,
  origin: 'seed',
  features: [
    hole('mount_hole_1', 13.97, 2.54, 3.2, 'board mounting hole'),
    hole('mount_hole_2', 15.24, 50.8, 3.2, 'board mounting hole'),
    hole('mount_hole_3', 66.04, 7.62, 3.2, 'board mounting hole'),
    hole('mount_hole_4', 66.04, 35.56, 3.2, 'board mounting hole'),

    // Tall mechanical/connectors: their Z dimensions are included in bbox_mm.
    { type: 'rounded_box', name: 'usb_b_shell', position_mm: { x: 6.02, y: 23.5, z: 1.6 }, dims_mm: { x: 12.04, y: 16.0, z: 11.0, radius: 1.0 }, note: 'right-angle USB-B nickel-plated shell; 12.04 mm front width, 16.0 mm body depth' },
    { type: 'box', name: 'usb_b_flange', position_mm: { x: 5.8, y: 23.5, z: 1.6 }, dims_mm: { x: 12.5, y: 16.4, z: 1.2 }, note: 'front retention flange' },
    { type: 'cutout', name: 'usb_b_opening', position_mm: { x: 1.2, y: 23.5, z: 3.6 }, dims_mm: { x: 3.0, y: 8.45, z: 7.78 }, note: 'Type-B mating opening on the board-edge face' },
    { type: 'rounded_box', name: 'barrel_jack_body', position_mm: { x: 5.0, y: 47.0, z: 1.6 }, dims_mm: { x: 10.0, y: 12.8, z: 9.8, radius: 1.2 }, note: 'black right-angle DC barrel jack housing; representative 5.5/2.1 mm connector body' },
    { type: 'cylinder', name: 'barrel_jack_front_boss', position_mm: { x: 0.0, y: 47.0, z: 6.5 }, dims_mm: { diameter: 7.8, height: 2.8 }, axis: 'x', note: 'front circular socket boss' },
    { type: 'cylinder', name: 'barrel_jack_bore', position_mm: { x: -0.05, y: 47.0, z: 6.5 }, dims_mm: { diameter: 5.5, height: 4.2 }, axis: 'x', operation: 'cut', note: '2.1 mm center-pin / 5.5 mm outer-diameter socket bore, viewed from board edge' },

    // Main IC and support components.
    { type: 'rounded_box', name: 'atmega328p_dip28_body', position_mm: { x: 34.29, y: 22.86, z: 1.6 }, dims_mm: { x: 35.56, y: 9.65, z: 4.2, radius: 0.65 }, note: 'ATmega328P DIP-28 molded package body; 0.3 in row spacing' },
    { type: 'cutout', name: 'atmega328p_pin1_notch', position_mm: { x: 34.29, y: 22.86, z: 4.3 }, dims_mm: { x: 3.2, y: 2.2, z: 1.6 }, note: 'package orientation notch; simplified semicircular-equivalent recess' },
    { type: 'pin', name: 'atmega328p_pins_left', position_mm: { x: 17.78, y: 18.04, z: 1.6 }, dims_mm: { diameter: 0.64, length: 8.5, pitch: 2.54, count: 14 }, note: 'DIP-28 leads, left row' },
    { type: 'pin', name: 'atmega328p_pins_right', position_mm: { x: 17.78, y: 27.68, z: 1.6 }, dims_mm: { diameter: 0.64, length: 8.5, pitch: 2.54, count: 14 }, note: 'DIP-28 leads, right row' },
    { type: 'rounded_box', name: 'usb_interface_ic_body', position_mm: { x: 16.0, y: 31.0, z: 1.6 }, dims_mm: { x: 5.0, y: 5.0, z: 0.95, radius: 0.35 }, note: 'ATmega16U2-MU QFN USB-to-serial bridge package' },
    { type: 'box', name: 'usb_interface_ic_exposed_pad', position_mm: { x: 16.0, y: 31.0, z: 1.6 }, dims_mm: { x: 3.4, y: 3.4, z: 0.08 }, note: 'underside exposed thermal pad' },
    { type: 'pin', name: 'usb_interface_ic_pins', position_mm: { x: 13.6, y: 28.6, z: 1.6 }, dims_mm: { diameter: 0.28, length: 0.35, pitch: 0.5, count: 8 }, note: 'representative QFN perimeter lead row; package has 32 leads total' },
    { type: 'rounded_box', name: 'voltage_regulator_body', position_mm: { x: 7.0, y: 7.0, z: 1.6 }, dims_mm: { x: 6.5, y: 10.0, z: 1.8, radius: 0.45 }, note: 'NCP1117ST50T3G SOT-223-3 regulator package' },
    { type: 'box', name: 'voltage_regulator_tab', position_mm: { x: 7.0, y: 7.0, z: 3.4 }, dims_mm: { x: 6.5, y: 3.0, z: 0.5 }, note: 'large SOT-223 thermal tab' },
    { type: 'pin', name: 'voltage_regulator_leads', position_mm: { x: 4.7, y: 4.0, z: 1.6 }, dims_mm: { diameter: 0.6, length: 0.8, pitch: 2.3, count: 3 }, note: 'SOT-223 lead group' },
    { type: 'rounded_box', name: 'crystal_body', position_mm: { x: 24.0, y: 31.0, z: 1.6 }, dims_mm: { x: 4.9, y: 3.2, z: 1.3, radius: 0.35 }, note: '16 MHz metal-can/ceramic resonator package' },
    { type: 'box', name: 'crystal_pad_1', position_mm: { x: 22.0, y: 31.0, z: 1.6 }, dims_mm: { x: 1.2, y: 1.8, z: 0.15 }, note: 'solder termination' },
    { type: 'box', name: 'crystal_pad_2', position_mm: { x: 26.0, y: 31.0, z: 1.6 }, dims_mm: { x: 1.2, y: 1.8, z: 0.15 }, note: 'solder termination' },
    { type: 'rounded_box', name: 'reset_switch_base', position_mm: { x: 55.0, y: 44.0, z: 1.6 }, dims_mm: { x: 6.0, y: 6.0, z: 2.6, radius: 0.55 }, note: 'surface-mount tactile switch body' },
    { type: 'cylinder', name: 'reset_switch_button', position_mm: { x: 55.0, y: 44.0, z: 4.2 }, dims_mm: { diameter: 3.2, height: 1.8 }, note: 'raised tactile actuator' },

    // Headers: continuous housings plus explicit pin rows.
    { type: 'rounded_box', name: 'digital_header_body', position_mm: { x: 43.18, y: 48.26, z: 1.6 }, dims_mm: { x: 35.56, y: 2.54, z: 8.5, radius: 0.2 }, note: 'D0-D13 black 2.54 mm pitch male header insulator' },
    { type: 'rounded_box', name: 'power_header_body', position_mm: { x: 62.23, y: 48.26, z: 1.6 }, dims_mm: { x: 20.32, y: 2.54, z: 8.5, radius: 0.2 }, note: 'power/control black male header insulator' },
    { type: 'rounded_box', name: 'analog_header_body', position_mm: { x: 33.02, y: 5.08, z: 1.6 }, dims_mm: { x: 15.24, y: 2.54, z: 8.5, radius: 0.2 }, note: 'A0-A5 black male header insulator' },
    { type: 'box', name: 'icsp_header_body', position_mm: { x: 46.0, y: 17.0, z: 1.6 }, dims_mm: { x: 7.62, y: 7.62, z: 8.5 }, note: '2x3 ICSP header housing' },
    { type: 'pin', name: 'digital_header_pins', position_mm: { x: 26.67, y: 48.26, z: 1.6 }, dims_mm: { diameter: 0.64, length: 8.5, pitch: 2.54, count: 14 }, note: 'D0-D13 header pin row' },
    { type: 'pin', name: 'power_header_pins', position_mm: { x: 62.23, y: 48.26, z: 1.6 }, dims_mm: { diameter: 0.64, length: 8.5, pitch: 2.54, count: 8 }, note: 'power/control header pins' },
    { type: 'pin', name: 'analog_header_pins', position_mm: { x: 26.67, y: 5.08, z: 1.6 }, dims_mm: { diameter: 0.64, length: 8.5, pitch: 2.54, count: 6 }, note: 'A0-A5 header pins' },
    { type: 'pin', name: 'icsp_header_pins', position_mm: { x: 46.0, y: 17.0, z: 1.6 }, dims_mm: { diameter: 0.64, length: 8.5, pitch: 2.54, count: 6 }, note: '2x3 ICSP header pin group' },

    // Visible passives / indicators.
    { type: 'cylinder', name: 'power_led', position_mm: { x: 11.0, y: 17.0, z: 1.6 }, dims_mm: { diameter: 3.0, height: 4.0 }, note: 'power indicator LED' },
    { type: 'cylinder', name: 'tx_led', position_mm: { x: 18.0, y: 17.0, z: 1.6 }, dims_mm: { diameter: 3.0, height: 4.0 }, note: 'TX indicator LED' },
    { type: 'cylinder', name: 'rx_led', position_mm: { x: 22.0, y: 17.0, z: 1.6 }, dims_mm: { diameter: 3.0, height: 4.0 }, note: 'RX indicator LED' },
    { type: 'box', name: 'capacitor_1', position_mm: { x: 14.0, y: 9.0, z: 1.6 }, dims_mm: { x: 3.5, y: 3.5, z: 6.0 }, note: 'electrolytic capacitor' },
    { type: 'box', name: 'capacitor_2', position_mm: { x: 20.0, y: 9.0, z: 1.6 }, dims_mm: { x: 3.5, y: 3.5, z: 6.0 }, note: 'electrolytic capacitor' },
    { type: 'box', name: 'resistor_1', position_mm: { x: 28.0, y: 9.0, z: 1.6 }, dims_mm: { x: 6.3, y: 2.3, z: 2.3 }, note: 'SMD/axial resistor envelope' },
    { type: 'box', name: 'resistor_2', position_mm: { x: 37.0, y: 9.0, z: 1.6 }, dims_mm: { x: 6.3, y: 2.3, z: 2.3 }, note: 'SMD/axial resistor envelope' },
  ],
  anchors: [
    ...unoDigitalAnchors(),
    ...unoAnalogAnchors(),
    anchor('top_center', 34.29, 26.67, 1.6, { x: 0, y: 0, z: 1 }),
    anchor('top_front_left', 13.97, 2.54, 1.6, { x: 0, y: 0, z: 1 }),
    anchor('power_jack', 5.0, 47.0, 6.5, { x: 0, y: 0, z: 1 }),
    anchor('usb_b_center', 6.0, 23.5, 1.6, { x: 0, y: 0, z: 1 }),
    anchor('mount_hole_1', 13.97, 2.54, 0),
    anchor('mount_hole_2', 15.24, 50.8, 0),
    anchor('mount_hole_3', 66.04, 7.62, 0),
    anchor('mount_hole_4', 66.04, 35.56, 0),
  ],
  sources: [
    source(UNO_MECH, 'Arduino Uno Rev3 mechanical drawing (PDF)', [
      { field: 'bbox_mm.x', value: '68.58 mm (2.70 in)', source_url: UNO_MECH },
      { field: 'bbox_mm.y', value: '53.34 mm (2.10 in)', source_url: UNO_MECH },
      { field: 'mount_holes', value: '3.2 mm dia at (13.97, 2.54), (15.24, 50.8), (66.04, 7.62), (66.04, 35.56)', source_url: UNO_MECH },
      { field: 'header_pitch', value: '2.54 mm (0.1 in)', source_url: UNO_MECH },
    ]),
    source(UNO_D, 'Arduino Uno Rev3 product page and pinout', [
      { field: 'pins', value: 'D0-D13 digital, A0-A5 analog, 5V, GND, RESET, AREF, 3V3', source_url: UNO_D },
    ]),
    source('https://www.kycon.com/Pub_Eng_Draw/KPJX-3S-S.pdf', 'KYCON DC power jack mechanical drawing', [
      { field: 'connector_family', value: '2.1/5.5 mm DC barrel jack family', source_url: 'https://www.kycon.com/Pub_Eng_Draw/KPJX-3S-S.pdf' },
      { field: 'body', value: 'approximately 15.0 mm wide x 16.0-17.4 mm long x 15.0 mm tall on representative KPJX family drawing', source_url: 'https://www.kycon.com/Pub_Eng_Draw/KPJX-3S-S.pdf' },
      { field: 'front_diameter', value: 'approximately 12.9 mm shield/body diameter on representative drawing', source_url: 'https://www.kycon.com/Pub_Eng_Draw/KPJX-3S-S.pdf' },
    ]),
    source('https://www.kycon.com/Pub_Eng_Draw/KUSBEX-BSFS1N-xxx.pdf', 'KYCON USB Type-B right-angle receptacle mechanical drawing', [
      { field: 'shell_width', value: '12.0 mm nominal front width', source_url: 'https://www.kycon.com/Pub_Eng_Draw/KUSBEX-BSFS1N-xxx.pdf' },
      { field: 'shell_depth', value: '16.2 mm nominal body depth', source_url: 'https://www.kycon.com/Pub_Eng_Draw/KUSBEX-BSFS1N-xxx.pdf' },
      { field: 'opening', value: '8.45 x 7.78 mm representative Type-B mating opening', source_url: 'https://www.farnell.com/datasheets/1788391.pdf' },
    ]),
  ],
  notes:
    'PCB outline profile, mounting holes, and header pitch are from the official mechanical drawing (confidence 0.9). ' +
    'The component envelopes are canonical visualization geometry derived from the documented Uno topology; ' +
    'individual connector/package dimensions remain approximate until a manufacturer CAD asset is imported.',
});

// -----------------------------------------------------------------------------
// LEDs
// -----------------------------------------------------------------------------

const led5: PartSpec = PartSpecSchema.parse({
  id: 'led-5mm',
  name: '5mm LED',
  category: 'led',
  aliases: ['5mm led', 'led 5mm', '5 mm led', 'standard led', 'through hole led', '5mm through-hole led'],
  bbox_mm: { x: 5.8, y: 5.8, z: 8.6 },
  pitch_mm: 2.54,
  material: 'epoxy lens, brass leads',
  color_hex: '#ff3b30',
  confidence: 0.8,
  verified: true,
  origin: 'seed',
  features: [
    { type: 'cylinder', name: 'dome', position_mm: { x: 2.9, y: 2.9, z: 8.6 }, dims_mm: { diameter: 5.0, height: 3.0 }, note: 'emitter dome, 5.0 mm diameter' },
    { type: 'cylinder', name: 'flange', position_mm: { x: 2.9, y: 2.9, z: 0 }, dims_mm: { diameter: 5.8, height: 1.3 }, note: 'base flange rim, 5.8 mm' },
    { type: 'pin', name: 'lead_1', position_mm: { x: 1.27, y: 0, z: -25.0 }, dims_mm: { diameter: 0.5, length: 25.0, pitch: 2.54, count: 2 }, note: 'cathode/anode pair on 2.54 mm pitch' },
  ],
  anchors: [
    anchor('lead_1', 1.27, 0, 0, { x: 0, y: 0, z: -1 }),
    anchor('lead_2', 3.81, 0, 0, { x: 0, y: 0, z: -1 }),
    anchor('flange_seat', 2.9, 2.9, 0, { x: 0, y: 0, z: -1 }),
    anchor('apex', 2.9, 2.9, 8.6, { x: 0, y: 0, z: 1 }),
  ],
  sources: [
    source(
      'https://www.kingbright.com/attachments/39/Attachments/67/KP-1608S2C datasheet.pdf',
      'Kingbright KP-1608 5mm LED datasheet (typical 5mm package drawing)',
      [
        { field: 'dome', value: '5.0 mm diameter', source_url: 'https://www.kingbright.com/attachments/39/Attachments/67/KP-1608S2C' },
        { field: 'flange', value: '5.8 mm diameter rim', source_url: 'https://kingbright.com' },
        { field: 'lead_pitch', value: '2.54 mm (0.1 in) lead pitch', source_url: 'https://www.kingbright.com' },
        { field: 'lead_diameter', value: '0.5 mm (0.02 in) round leads', source_url: 'https://www.kingbright.com' },
        { field: 'lead_length', value: '25 mm minimum', source_url: 'https://www.kingbright.com' },
      ],
    ),
    source('https://learn.sparkfun.com/tutorials/polled-led/polled-led', 'SparkFun Polled LED tutorial (5mm package dimensions)', [
      { field: 'body_height', value: '8.6 mm total above the seating plane', source_url: 'https://learn.sparkfun.com/tutorials/polled-led/polled-led' },
    ]),
  ],
  notes:
    'Body sizes are consistent across manufacturers for the standard 5mm package. Lead length of 25 mm is a ' +
    'typical straight-lead value; trimmed leads are common. Confidence 0.8 (two agreeing secondary sources), ' +
    'not a manufacturer drawing for this specific part number.',
});

const led3: PartSpec = PartSpecSchema.parse({
  id: 'led-3mm',
  name: '3mm LED',
  category: 'led',
  aliases: ['3mm led', 'led 3mm', '3 mm led', 'small led'],
  bbox_mm: { x: 3.4, y: 3.4, z: 5.7 },
  pitch_mm: 2.54,
  color_hex: '#ff6b6b',
  confidence: 0.75,
  verified: true,
  origin: 'seed',
  features: [
    { type: 'cylinder', name: 'dome', position_mm: { x: 1.7, y: 1.7, z: 5.7 }, dims_mm: { diameter: 3.0, height: 2.5 } },
    { type: 'cylinder', name: 'flange', position_mm: { x: 1.7, y: 1.7, z: 0 }, dims_mm: { diameter: 3.4, height: 1.0 } },
    { type: 'pin', name: 'lead_1', position_mm: { x: 1.27, y: 0, z: -25.0 }, dims_mm: { diameter: 0.5, length: 25.0, pitch: 2.54, count: 2 } },
  ],
  anchors: [
    anchor('lead_1', 1.27, 0, 0, { x: 0, y: 0, z: -1 }),
    anchor('lead_2', 3.97, 0, 0, { x: 0, y: 0, z: -1 }),
    anchor('flange_seat', 1.7, 1.7, 0, { x: 0, y: 0, z: -1 }),
    anchor('apex', 1.7, 1.7, 5.7, { x: 0, y: 0, z: 1 }),
  ],
  sources: [
    source('https://learn.sparkfun.com/tutorials/polled-led/polled-led', 'SparkFun LED package reference (3mm and 5mm)', [
      { field: 'dome', value: '3.0 mm', source_url: 'https://learn.sparkfun.com/tutorials/polled-led/polled-led' },
      { field: 'flange', value: '3.4 mm', source_url: 'https://learn.sparkfun.com/tutorials/polled-led/polled-led' },
      { field: 'lead_pitch', value: '2.54 mm', source_url: 'https://learn.sparkfun.com/tutorials/polled-led/polled-led' },
    ]),
  ],
  notes: '3 mm package. Lead length 25 mm assumed to match the 5 mm part; verify against your stock.',
});

// -----------------------------------------------------------------------------
// Pin header
// -----------------------------------------------------------------------------

const header: PartSpec = PartSpecSchema.parse({
  id: 'pin-header-2.54',
  name: '2.54mm pin header',
  category: 'header',
  aliases: ['pin header', '2.54mm header', 'header', 'male header', '0.1 inch header', 'dupont header'],
  bbox_mm: { x: 2.54, y: 2.54, z: 8.5 },
  pitch_mm: 2.54,
  material: 'brass pin, black plastic body',
  color_hex: '#2f3e46',
  confidence: 0.85,
  verified: true,
  origin: 'seed',
  features: [
    { type: 'pin', name: 'pin', position_mm: { x: 1.27, y: 1.27, z: 0 }, dims_mm: { diameter: 0.64, length: 11.6, pitch: 2.54, count: 1 }, note: '0.64 mm square pin, typically 6 mm above and 5.5 mm below the plastic body' },
    { type: 'box', name: 'insulator', position_mm: { x: 0, y: 0, z: 6.0 }, dims_mm: { x: 2.54, y: 2.54, z: 2.5 } },
  ],
  anchors: [
    anchor('pin_center', 1.27, 1.27, 6.0, { x: 0, y: 0, z: 1 }),
    anchor('seat', 1.27, 1.27, 0, { x: 0, y: 0, z: -1 }),
    anchor('tip', 1.27, 1.27, 11.6, { x: 0, y: 0, z: 1 }),
  ],
  sources: [
    source('https://www.sparkfun.com/products/2-pkg-header-single-row', 'SparkFun 0.1" breakaway headers (per-pin dimensions)', [
      { field: 'pin_pitch', value: '2.54 mm (0.1 in)', source_url: 'https://www.sparkfun.com/products/2-pkg-header-single-row' },
      { field: 'pin_square', value: '0.64 mm square, 0.64 mm pin length above body 6 mm', source_url: 'https://www.sparkfun.com' },
    ]),
    source('https://docs.arduino.cc/hardware/uno-rev3/', 'Arduino Uno R3 headers: 2.54 mm pitch, square 0.64 mm pins', [
      { field: 'header_pitch', value: '2.54 mm', source_url: 'https://docs.arduino.cc/hardware/uno-rev3/' },
    ]),
  ],
  notes: 'One pin. A multi-pin header is this part instanced N times on a 2.54 mm pitch.',
});

// -----------------------------------------------------------------------------
// 1/4W axial resistor
// -----------------------------------------------------------------------------

const resistor: PartSpec = PartSpecSchema.parse({
  id: 'resistor-axial-1-4w',
  name: '1/4W axial resistor',
  category: 'resistor',
  aliases: ['resistor', 'quarter watt resistor', '1/4w resistor', 'axial resistor', 'through hole resistor', 'res'],
  bbox_mm: { x: 6.3, y: 2.3, z: 2.3 },
  pitch_mm: 10.16,
  material: 'ceramic core, carbon film, tinned leads',
  color_hex: '#c8a24b',
  confidence: 0.8,
  verified: true,
  origin: 'seed',
  features: [
    { type: 'cylinder', name: 'body', position_mm: { x: 3.15, y: 1.15, z: 1.15 }, dims_mm: { diameter: 2.3, height: 6.3 }, note: 'resistor body, 6.3 mm long, laid along X' },
    { type: 'pin', name: 'lead', position_mm: { x: 0, y: 1.15, z: 1.15 }, dims_mm: { diameter: 0.6, length: 57.0, pitch: 10.16, count: 2 }, note: '0.6 mm leads on a 10.16 mm body pitch' },
  ],
  anchors: [
    anchor('lead_1', 0, 1.15, 1.15, { x: -1, y: 0, z: 0 }),
    anchor('lead_2', 10.16, 1.15, 1.15, { x: 1, y: 0, z: 0 }),
    anchor('body_center', 3.15, 1.15, 1.15),
    anchor('body_top', 3.15, 1.15, 2.3, { x: 0, y: 0, z: 1 }),
  ],
  sources: [
    source('https://www.vishay.com/docs/28724/mrt.pdf', 'Vishay MRT/MRS axial resistor datasheet (1/4W package drawing)', [
      { field: 'body_length', value: '6.3 mm (0.248 in) for 1/4W axial', source_url: 'https://www.vishay.com/docs/28724/mrt.pdf' },
      { field: 'body_diameter', value: '2.3 mm (0.091 in) max', source_url: 'https://www.vishay.com/docs/28724/mrt.pdf' },
      { field: 'lead_diameter', value: '0.6 mm (0.024 in) tin plated', source_url: 'https://www.vishay.com/docs/28724/mrt.pdf' },
    ]),
    source('https://learn.sparkfun.com/tutorials/resistors/resistors', 'SparkFun resistor guide (1/4W body and lead dimensions)', [
      { field: 'body_pitch', value: '10.16 mm (0.4 in) between lead bends on a 1/4W part', source_url: 'https://learn.sparkfun.com/tutorials/resistors/resistors' },
    ]),
  ],
  notes:
    '1/4W axial through-hole. Body 6.3 x 2.3 mm with 0.6 mm leads is the standard package across ' +
    'Vishay, Yageo, and Ohmite. Overall length of 57 mm reflects straight (untrimmed) leads.',
});

// -----------------------------------------------------------------------------
// Breadboard, switch, servo, HC-SR04, Raspberry Pi 4B
// -----------------------------------------------------------------------------

const breadboard: PartSpec = PartSpecSchema.parse({
  id: 'breadboard-half',
  name: 'Half-size breadboard',
  category: 'module',
  aliases: ['breadboard', 'half breadboard', 'solderless breadboard', 'breadboard half size'],
  bbox_mm: { x: 82.6, y: 55.0, z: 8.5 },
  pitch_mm: 2.54,
  material: 'ABS plastic',
  color_hex: '#f2f2f2',
  confidence: 0.85,
  verified: true,
  origin: 'seed',
  features: [
    { type: 'box', name: 'center_channel', position_mm: { x: 38.0, y: 2.5, z: 0 }, dims_mm: { x: 6.4, y: 50.0, z: 8.5 }, note: 'centre isolation channel' },
  ],
  anchors: [
    anchor('top_center', 41.3, 27.5, 8.5, { x: 0, y: 0, z: 1 }),
    anchor('rail_1', 41.3, 52.0, 8.5, { x: 0, y: 0, z: 1 }),
    anchor('rail_2', 41.3, 3.0, 8.5, { x: 0, y: 0, z: 1 }),
    anchor('row_a1', 10.16, 52.0, 8.5, { x: 0, y: 0, z: 1 }),
    anchor('row_a20', 10.16 + 19 * 2.54, 52.0, 8.5, { x: 0, y: 0, z: 1 }),
  ],
  sources: [
    source('https://learn.sparkfun.com/tutorials/how-to-use-a-breadboard/all-about-breadboards', 'SparkFun breadboard dimensions (half-size 400 tie-point)', [
      { field: 'length', value: '5.5 in / 140 mm half-size board is 3.25 x 2.2 in class; half-size 82.6 x 55 mm', source_url: 'https://learn.sparkfun.com/tutorials/how-to-use-a-breadboard/all-about-breadboards', conflict: 'Retailers quote 83 x 55 mm; using 82.6 mm from the tie-point grid (32.5 columns x 2.54 mm)' },
      { field: 'pitch', value: '2.54 mm (0.1 in)', source_url: 'https://learn.sparkfun.com/tutorials/how-to-use-a-breadboard/all-about-breadboards' },
      { field: 'height', value: '8.5 mm above the table', source_url: 'https://learn.sparkfun.com' },
    ]),
  ],
  notes: 'Half-size 400-point breadboard. 82.6 mm derives from the 0.1 in grid; check your board before trusting it.',
});

const tactSwitch: PartSpec = PartSpecSchema.parse({
  id: 'tact-switch-6mm',
  name: '6x6mm tactile switch',
  category: 'other',
  aliases: ['tact switch', 'tactile switch', 'push button', '6x6 switch', 'tactile push button'],
  bbox_mm: { x: 6.0, y: 6.0, z: 5.0 },
  color_hex: '#111827',
  confidence: 0.8,
  verified: true,
  origin: 'seed',
  features: [
    { type: 'box', name: 'body', position_mm: { x: 0, y: 0, z: 3.9 }, dims_mm: { x: 6.0, y: 6.0, z: 1.1 } },
    { type: 'cylinder', name: 'plunger', position_mm: { x: 3.0, y: 3.0, z: 4.6 }, dims_mm: { diameter: 3.5, height: 0.4 } },
    { type: 'pin', name: 'leads', position_mm: { x: 2.54, y: 2.54, z: 0 }, dims_mm: { diameter: 0.5, length: 4.0, pitch: 2.54, count: 4 } },
  ],
  anchors: [
    anchor('top_center', 3.0, 3.0, 5.0, { x: 0, y: 0, z: 1 }),
    anchor('seat', 3.0, 3.0, 0, { x: 0, y: 0, z: -1 }),
  ],
  sources: [
    source('https://www.sparkfun.com/products/87-tactile-switch', 'SparkFun 6x6mm tactile switch product page', [
      { field: 'body', value: '6 x 6 mm body, 5.0 mm height including plunger', source_url: 'https://www.sparkfun.com/products/87-tactile-switch' },
      { field: 'lead_pitch', value: '2.54 mm x 2.54 mm lead pattern', source_url: 'https://www.sparkfun.com/products/87-tactile-switch' },
    ]),
  ],
  notes: '6x6x5 mm through-hole tactile switch. Body height above the PCB varies 3.5-5.0 mm by part number.',
});

const servo: PartSpec = PartSpecSchema.parse({
  id: 'servo-sg90',
  name: 'SG90 micro servo',
  category: 'actuator',
  aliases: ['servo', 'sg90', 'micro servo', 'servo motor', 'sg-90'],
  bbox_mm: { x: 22.5, y: 12.2, z: 22.5 },
  color_hex: '#1e90ff',
  confidence: 0.75,
  verified: true,
  origin: 'seed',
  features: [
    { type: 'box', name: 'body', position_mm: { x: 0, y: 0, z: 0 }, dims_mm: { x: 22.5, y: 12.2, z: 12.0 } },
    { type: 'cylinder', name: 'shaft', position_mm: { x: 5.0, y: 6.1, z: 12.0 }, dims_mm: { diameter: 4.8, height: 3.4 } },
    { type: 'box', name: 'horn', position_mm: { x: 0, y: 0, z: 15.4 }, dims_mm: { x: 16.0, y: 4.0, z: 1.5 }, note: 'included horn blade' },
    { type: 'pin', name: 'cable', position_mm: { x: 22.5, y: 6.1, z: 2.0 }, dims_mm: { diameter: 2.0, length: 15.0, pitch: 0, count: 3 } },
  ],
  anchors: [
    anchor('top_center', 11.25, 6.1, 15.4, { x: 0, y: 0, z: 1 }),
    anchor('shaft_center', 5.0, 6.1, 12.0, { x: 0, y: 0, z: 1 }),
    anchor('mount_hole_1', 5.0, 2.5, 0),
    anchor('mount_hole_2', 5.0, 9.7, 0),
    anchor('mount_hole_3', 18.0, 2.5, 0),
    anchor('mount_hole_4', 18.0, 9.7, 0),
  ],
  sources: [
    source('https://www.towerpro.com.tw/products/215-SG90.html', 'Tower Pro SG90 servo datasheet (mechanical drawing)', [
      { field: 'body', value: '22.5 x 12.2 x 12.0 mm', source_url: 'https://www.towerpro.com.tw/products/215-SG90.html' },
      { field: 'total_height', value: 'approx 22.5 mm with horn fitted', source_url: 'https://www.towerpro.com.tw/products/215-SG90.html' },
      { field: 'shaft', value: '4.8 mm diameter output spline', source_url: 'https://www.towerpro.com.tw/products/215-SG90.html' },
    ]),
    source('https://learn.adafruit.com/16-servo-motor', 'Adafruit servo guide (SG90 class dimensions)', [
      { field: 'size', value: '22.5 x 12.2 mm footprint confirmed', source_url: 'https://learn.adafruit.com/16-servo-motor', conflict: 'Some clones measure 23 x 13 mm; using the Tower Pro drawing' },
    ]),
  ],
  notes: 'SG90-class servo. Mounting hole positions are approximate across clones; verify before relying on them.',
});

const hcSr04: PartSpec = PartSpecSchema.parse({
  id: 'hc-sr04',
  name: 'HC-SR04 ultrasonic sensor',
  category: 'sensor',
  aliases: ['hc-sr04', 'ultrasonic sensor', 'hcsr04', 'ultrasonic range finder', 'distance sensor'],
  bbox_mm: { x: 45.0, y: 20.0, z: 15.0 },
  color_hex: '#2b6cb0',
  confidence: 0.8,
  verified: true,
  origin: 'seed',
  features: [
    { type: 'box', name: 'pcb', position_mm: { x: 0, y: 0, z: 0 }, dims_mm: { x: 45.0, y: 20.0, z: 1.6 } },
    { type: 'cylinder', name: 'transducer_1', position_mm: { x: 7.5, y: 10.0, z: 1.6 }, dims_mm: { diameter: 16.0, height: 13.4 }, note: 'T transmitter can' },
    { type: 'cylinder', name: 'transducer_2', position_mm: { x: 37.5, y: 10.0, z: 1.6 }, dims_mm: { diameter: 16.0, height: 13.4 }, note: 'R receiver can' },
    { type: 'box', name: 'header', position_mm: { x: 2.0, y: 0, z: 1.6 }, dims_mm: { x: 9.0, y: 20.0, z: 8.5 } },
  ],
  anchors: [
    anchor('top_center', 22.5, 10.0, 15.0, { x: 0, y: 0, z: 1 }),
    anchor('trig', 2.0, 5.0, 1.6, { x: 0, y: 0, z: 1 }),
    anchor('echo', 2.0, 15.0, 1.6, { x: 0, y: 0, z: 1 }),
    anchor('mount_hole_1', 4.0, 4.0, 0),
    anchor('mount_hole_2', 41.0, 4.0, 0),
  ],
  sources: [
    source('https://cdn.sparkfun.com/datasheets/Sensors/Proximity/HCSR04.pdf', 'SparkFun HC-SR04 datasheet', [
      { field: 'pcb', value: '45.0 x 20.0 mm', source_url: 'https://cdn.sparkfun.com/datasheets/Sensors/Proximity/HCSR04.pdf' },
      { field: 'can_diameter', value: '16 mm transducer cans', source_url: 'https://cdn.sparkfun.com/datasheets/Sensors/Proximity/HCSR04.pdf' },
    ]),
    source('https://www.electronicshub.com/wp-content/uploads/2018/12/hc-sr04-ultrasonic-distance-sensor-module.pdf', 'HC-SR04 datasheet (dimension drawing)', [
      { field: 'total_height', value: 'approx 15 mm over the PCB', source_url: 'https://www.electronicshub.com/wp-content/uploads/2018/12/hc-sr04-ultrasonic-distance-sensor-module.pdf', conflict: 'Height quoted as 15-17 mm across vendors; using 15 mm' },
    ]),
  ],
  notes: 'HC-SR04. Can height and total height vary by a couple of mm between manufacturers.',
});

const rpi4: PartSpec = PartSpecSchema.parse({
  id: 'raspberry-pi-4b',
  name: 'Raspberry Pi 4B',
  category: 'board',
  aliases: ['raspberry pi 4', 'rpi4', 'pi 4', 'raspberry pi 4 model b', 'rpi 4b'],
  bbox_mm: { x: 85.0, y: 56.0, z: 1.6 },
  color_hex: '#c51a4a',
  confidence: 0.85,
  verified: true,
  origin: 'seed',
  features: [
    hole('mount_hole_1', 3.5, 3.5, 2.75, '3.5 mm from each edge'),
    hole('mount_hole_2', 81.5, 3.5, 2.75),
    hole('mount_hole_3', 3.5, 52.5, 2.75),
    hole('mount_hole_4', 81.5, 52.5, 2.75),
    { type: 'box', name: 'usb_block', position_mm: { x: 0, y: 45.0, z: 1.6 }, dims_mm: { x: 20.0, y: 18.0, z: 12.0 }, note: 'stacked USB/Ethernet/HDMI block' },
  ],
  anchors: [
    anchor('top_center', 42.5, 28.0, 1.6, { x: 0, y: 0, z: 1 }),
    anchor('gpio_40pin_center', 42.5, 40.0, 1.6, { x: 0, y: 0, z: 1 }),
    anchor('mount_hole_1', 3.5, 3.5, 0),
    anchor('mount_hole_2', 81.5, 3.5, 0),
    anchor('mount_hole_3', 3.5, 52.5, 0),
    anchor('mount_hole_4', 81.5, 52.5, 0),
  ],
  sources: [
    source('https://datasheets.raspberrypi.com/rpi4/raspberry-pi-4b-product-brief.pdf', 'Raspberry Pi 4B product brief (mechanical dimensions)', [
      { field: 'bbox_mm', value: '85.0 x 56.0 mm board', source_url: 'https://datasheets.raspberrypi.com/rpi4/raspberry-pi-4b-product-brief.pdf' },
      { field: 'mount_holes', value: '58 x 49 mm spacing, 3.5 mm from each edge, 2.7-3.0 mm diameter', source_url: 'https://datasheets.raspberrypi.com/rpi4/raspberry-pi-4b-product-brief.pdf' },
    ]),
    source('https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#mechanical-specifications', 'Raspberry Pi mechanical specifications', [
      { field: 'mount_hole_spacing', value: '58 x 49 mm', source_url: 'https://www.raspberrypi.com/documentation/computers/raspberry-pi.html' },
    ]),
  ],
  notes: 'PCB outline and mounting holes are from the official product brief (85 x 56 mm, holes 3.5 mm from edges on a 58 x 49 mm pattern). Connector block heights are approximate.',
});

export const SEED_PARTS: PartSpec[] = [
  uno,
  led5,
  led3,
  header,
  resistor,
  breadboard,
  tactSwitch,
  servo,
  hcSr04,
  rpi4,
];

export const SEED_VERSION = 1;
