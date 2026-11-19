/**
 * Text of the About box. `NOT_AFFILIATED` is the same paragraph as the "Not affiliated." line in README.md (the websites use it too);
 * a test keeps the two in step. Edit both together.
 */
export const NOT_AFFILIATED =
  "RSMPS is an independent project. It is not affiliated with, sponsored by or endorsed by Blackmagic Design, the Blender Foundation, Adobe, Ableton, Apple, or any other company, product or creator mentioned here. DaVinci Resolve, Fusion, Blender, Adobe Color, Ableton Live, ProRes, Resolume, DXV, DNxHR and CineForm are trademarks of their respective owners. They are named only to describe what inspired this tool or what it works with. Adobe Color inspired Palette Studio; Blender's shader nodes and DaVinci Resolve's Fusion page inspired the node workflow.";

/** The beta notice: shown on the badge next to the name, in the About box and on the start screen. One place to edit. */
export const BETA = {
  badge: 'Beta',
  short: 'RSMPS is in early development. Many features are new and not fully tested.',
  ask: 'If something looks wrong or breaks, please report it: every report helps.',
} as const;

export const ABOUT = {
  title: 'RipScorpy Media Processing Suite (RSMPS)',
  licence: 'License: MIT. The source is free.',
  source: 'https://github.com/GustafMos/rsmps',
  updates: 'The desktop app asks GitHub once a day whether a newer version exists and sends nothing else. You can turn this off.',
} as const;
