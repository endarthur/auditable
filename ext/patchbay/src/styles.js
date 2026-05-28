// @gcu/patchbay — panel styles. Each style varies surface (panel bg/edge,
// typography, LED + display aesthetics) while sharing the HP grid, rail
// geometry, screw convention, and Switchboard surface palette — the discipline
// that keeps a rack from collapsing into a sticker collection. render.js + pb.js
// read these; values are resolved against the live theme color table at draw
// time (a style names *which* role/look, not a fixed hex).

export const PANEL_STYLES = {
  studio: {
    label: 'Studio',
    panel: { top: 'bgBright', bottom: 'bgRaised', edge: 'border' },
    accentStripe: true,
    headerFont: '700 17px Barlow, sans-serif',
    headerColor: 'accent',           // 'accent' = module bandColor, else a role token
    labelFont: '9px "Space Mono", monospace',
    screws: true,
    led: 'pill',
    display: 'clean',
  },
  brutalist: {
    label: 'Brutalist',
    panel: { top: 'bgDeep', bottom: 'bgDeep', edge: 'rule' },
    accentStripe: false,
    headerFont: '700 16px "Space Mono", monospace',
    headerColor: 'text',
    labelFont: '8.5px "Space Mono", monospace',
    upperLabels: true,
    screws: true,
    led: 'pixel',
    display: 'pixel-lcd',
  },
  analog: {
    label: 'Analog',
    panel: { top: 'bgBright', bottom: 'bgRaised', edge: 'border' },
    accentStripe: true,
    headerFont: '700 17px Barlow, sans-serif',
    headerColor: 'accent',
    labelFont: '9px Barlow, sans-serif',
    screws: true,
    led: 'glow',
    display: 'crt',
  },
  lab: {
    label: 'Lab',
    panel: { top: 'bgDeep', bottom: 'bg', edge: 'rule' },
    accentStripe: true,
    headerFont: '600 16px Barlow, sans-serif',
    headerColor: 'text',
    labelFont: '9px Barlow, sans-serif',
    screws: true,
    led: 'ring',
    display: 'segment',
  },
  retro: {
    label: 'Retro',
    panel: { top: 'bgRaised', bottom: 'bgDeep', edge: 'amber' },
    accentStripe: true,
    headerFont: '700 17px Barlow, sans-serif',
    headerColor: 'amber',
    labelFont: '9px "Space Mono", monospace',
    screws: true,
    led: 'glow',
    display: 'vfd',
  },
  blank: {
    label: 'Blank',
    panel: { top: 'bgRaised', bottom: 'bgRaised', edge: 'border' },
    accentStripe: false,
    headerFont: '9px "Space Mono", monospace',
    headerColor: 'textSoft',
    labelFont: '9px "Space Mono", monospace',
    screws: true,
    led: 'pill',
    display: 'none',
  },
};

export function getStyle(name) {
  return PANEL_STYLES[name] || PANEL_STYLES.studio;
}

export function listStyles() {
  return Object.keys(PANEL_STYLES);
}
