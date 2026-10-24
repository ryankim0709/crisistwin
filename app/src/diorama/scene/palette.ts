/**
 * Art-direction palette for the diorama scene (sRGB hex; three converts to linear on use).
 * Meaning is also carried by shape, labels and motion, never colour alone.
 */
export const PALETTE = {
  haze: 0xe6dccb,
  hazeTop: 0xf1ebe0,
  hazeBottom: 0xd9cdb8,
  skyLight: 0xfff1dc,
  groundLight: 0x7d8f6a,
  sun: 0xfff0d6,

  meadow: 0xa9b98a,
  meadowLight: 0xbcc798,
  forest: 0x6b8a5a,
  deepForest: 0x52704a,
  sand: 0xdccba3,
  riverbed: 0x8e9b86,

  soilDark: 0x5e4a3a,
  soil: 0x8b6d50,
  clay: 0xa3866a,
  board: 0x34312e,

  waterDeep: 0x4d8790,
  waterShallow: 0x8cc0b5,
  waterGlint: 0xfffbe8,
  waterSide: 0x5f9ba0,

  roadMain: 0x6b7480,
  roadResidential: 0x7e8690,
  roadFire: 0xa68f6e,
  roadDash: 0xf3ecdc,
  stone: 0xcdbfa6,
  railing: 0xf4efe5,

  walls: [0xf2e9d9, 0xece1cd, 0xf5eee2],
  roofs: [0xc27a5a, 0x6f7b86, 0x8fa182, 0xb9917a],
  door: 0x5a4a3e,
  glass: 0x5d7383,
  chimney: 0xb9a48c,
  concrete: 0xcbc6ba,

  shelterRoof: 0x7f9188,
  cyan: 0x49c2d4,
  cyanBright: 0x7fe3f0,
  stationRed: 0xc4473b,
  stationDoor: 0xe4e0d8,
  stationRoof: 0x8d8f91,

  pineGreens: [0x5d7f55, 0x4f7049, 0x587a4e],
  roundGreens: [0x7f9a5e, 0x8fa766, 0x76935a],
  trunk: 0x6b5340,
  char: 0x2a2522,

  civilianBody: 0xf4eee3,
  civilianRoof: 0x4fc0d3,
  tyre: 0x2e3135,
  brake: 0xff6a4d,
  engineRed: 0xe5392b,
  engineStripe: 0xf7f3ea,
  engineLadder: 0xa9adb2,
  emergencyBlue: 0x4f8dff,
  pedestrian: 0x9be3ea,

  coral: 0xe2674c,
  amber: 0xffa23c,
  smoke: 0xa89f95,
  waterSpray: 0xe3f7ff,
  closure: 0xd9483b,
  ivory: 0xfbf6ec,
} as const;
