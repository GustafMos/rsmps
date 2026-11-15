import { memo } from 'react';

/** 16x16 grid icons, drawn with square caps so they read as crisp pixel glyphs. */
const PATHS = {
  eye: 'M1 8 C3 4 5.5 3 8 3 C10.5 3 13 4 15 8 C13 12 10.5 13 8 13 C5.5 13 3 12 1 8Z M8 6v4 M6.5 8h3',
  eyeOff: 'M1 8 C3 4 5.5 3 8 3 C10.5 3 13 4 15 8 C13 12 10.5 13 8 13 C5.5 13 3 12 1 8Z M2 14L14 2',
  power: 'M8 2v6 M4.5 4.5a5 5 0 1 0 7 0',
  play: 'M4 2.5v11l9-5.5z',
  pause: 'M4 3v10 M12 3v10',
  stepBack: 'M3 3v10 M13 3v10L6 8z',
  stepFwd: 'M13 3v10 M3 3v10l7-5z',
  loop: 'M3 7V6a2 2 0 0 1 2-2h7 M10 1.5L12.5 4 10 6.5 M13 9v1a2 2 0 0 1-2 2H4 M6 14.5L3.5 12 6 9.5',
  plus: 'M8 3v10 M3 8h10',
  minus: 'M3 8h10',
  close: 'M3.5 3.5l9 9 M12.5 3.5l-9 9',
  chevronDown: 'M3 6l5 5 5-5',
  chevronRight: 'M6 3l5 5-5 5',
  chevronLeft: 'M10 3L5 8l5 5',
  folder: 'M1.5 4h5l1.5 2h6.5v7.5h-13z',
  save: 'M2.5 2.5h9l2 2v9h-11z M5 2.5v4h6v-4 M5 13.5v-4h6v4',
  open: 'M1.5 4h5l1.5 2h6.5 M2.5 13.5l2-6.5h11l-2 6.5z',
  undo: 'M5 3L2 6l3 3 M2 6h7a4 4 0 0 1 0 8H6',
  redo: 'M11 3l3 3-3 3 M14 6H7a4 4 0 0 0 0 8h3',
  fit: 'M2 6V2h4 M10 2h4v4 M14 10v4h-4 M6 14H2v-4',
  one: 'M5 4l2-1.5V13 M10 5l4 6 M14 5l-4 6',
  maximize: 'M2.5 2.5h11v11h-11z',
  restore: 'M2.5 5.5h8v8h-8z M5.5 5.5v-3h8v8h-3',
  trash: 'M3 4.5h10 M6 4.5v-2h4v2 M4.5 4.5l.7 9h5.6l.7-9',
  grid: 'M2.5 2.5h11v11h-11z M2.5 8h11 M8 2.5v11',
  volume: 'M2 6h3l4-3v10l-4-3H2z M11.5 5.5a3.5 3.5 0 0 1 0 5',
  mute: 'M2 6h3l4-3v10l-4-3H2z M11 6l4 4 M15 6l-4 4',
  plug: 'M6 2v4 M10 2v4 M4 6h8v3a4 4 0 0 1-8 0z M8 13v2',
  export: 'M8 10V2 M4.5 5.5L8 2l3.5 3.5 M2.5 10v4h11v-4',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z M10.5 10.5l3.5 3.5',
  frame: 'M2.5 3.5h11v9h-11z M2.5 6.5h5',
  warn: 'M8 2l6.5 12h-13z M8 6.5v3.5 M8 12v.5',
  check: 'M3 8.5l3.5 3.5 7-8',
  drag: 'M5 3v.1 M5 8v.1 M5 13v.1 M11 3v.1 M11 8v.1 M11 13v.1',
  layout: 'M2.5 3h4v3h-4z M2.5 10h4v3h-4z M9.5 6.5h4v3h-4z M6.5 4.5h1.5v8 M8 8h1.5',
  menu: 'M2.5 4h11 M2.5 8h11 M2.5 12h11',
  help: 'M6 6a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.6 M8 12v.5',
  image: 'M2.5 3.5h11v9h-11z M2.5 11l3.5-3.5 3 3 2-2 2.5 2.5 M10.5 6.2v.1',
  video: 'M2.5 4h8v8h-8z M10.5 7l3-2v6l-3-2',
  audio: 'M2 6.5v3 M5 4.5v7 M8 2.5v11 M11 5v6 M14 7v2',
  midi: 'M2.5 3.5h11v9h-11z M6 3.5v9 M10 3.5v9 M4 3.5v5 M8 3.5v5 M12 3.5v5',
  file: 'M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3',
  brush: 'M13.5 2.5l-6 6 M7.5 8.5l-2.5 1 -1.5 3 3-1.5 1-2.5z',
  eyedrop: 'M13 2.5a2 2 0 0 1 0 3l-2 2 -3-3 2-2a2 2 0 0 1 3 0z M8 5l3 3 M8 8l-5 5v1h1l5-5',
  keyboard: 'M1.5 4.5h13v8h-13z M4 7.5h.1 M6.5 7.5h.1 M9 7.5h.1 M11.5 7.5h.1 M5 10h6',
  coffee: 'M2.5 5.5h9v4a3 3 0 0 1-3 3h-3a3 3 0 0 1-3-3z M11.5 6.5h1.5a1.5 1.5 0 0 1 0 3h-1.5 M5 2.5v1.5 M8 2.5v1.5',
  bug: 'M5.5 5.5h5v5a2.5 2.5 0 0 1-5 0z M8 5.5V3 M5.5 8H2.5 M10.5 8h3 M5.5 11l-2 1.5 M10.5 11l2 1.5 M6 3.5l-1.5-1 M10 3.5l1.5-1',
  swap: 'M2.5 5.5h10 M10 3l2.5 2.5L10 8 M13.5 10.5h-10 M6 8l-2.5 2.5L6 13',
  pin: 'M5.5 2.5h5l-.7 4 2.2 2.5h-8.4l2.2-2.5z M8 9v5',
  focus: 'M8 2v3 M8 11v3 M2 8h3 M11 8h3 M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
} as const;

export type IconName = keyof typeof PATHS;

export const Icon = memo(function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  const filled = name === 'play';
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      shapeRendering="crispEdges"
      aria-hidden="true"
      style={{ flex: 'none' }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
});
