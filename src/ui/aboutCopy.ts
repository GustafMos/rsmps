/**
 * Text of the About box. `NOT_AFFILIATED` is the same paragraph as the "Not affiliated." line in README.md (the websites use it too);
 * a test keeps the two in step. Edit both together.
 */
export const NOT_AFFILIATED =
  "RSMPS is an independent project. It is not affiliated with, sponsored by or endorsed by Blackmagic Design, the Blender Foundation, Adobe, Ableton, Apple, or any other company, product or creator mentioned here. DaVinci Resolve, Fusion, Blender, Adobe Color, Ableton Live and ProRes are trademarks of their respective owners. They are named only to describe what inspired this tool or what it works with. Adobe Color inspired Palette Studio; Blender's shader nodes and DaVinci Resolve's Fusion page inspired the node workflow.";

export const ABOUT = {
  title: 'RipScorpy Media Processing Suite (RSMPS)',
  licence: 'License: MIT. The source is free.',
  source: 'https://github.com/GustafMos/rsmps',
  updates: 'The desktop app asks GitHub once a day whether a newer version exists and sends nothing else. You can turn this off.',
} as const;
