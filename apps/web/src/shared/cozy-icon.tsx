const paths = {
  home: 'm3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V10m6 11v-8h6v8',
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.9-5.5a9 9 0 0 1-.9-4A8.5 8.5 0 0 1 12.5 3 8.5 8.5 0 0 1 21 11.5Z',
  pen: 'm16 3 5 5M3 21l5-1L21 7a2 2 0 0 0-4-4L4 16l-1 5Zm10 0h8',
  book: 'M20 21H6a3 3 0 0 1 0-6h14V3H6a3 3 0 0 0-3 3v12m17-3v6',
  read: 'M12 5v16M3 3h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3V3Z',
  person: 'M20 21v-2a7 7 0 0 0-14 0v2M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
  shield: 'm12 3 8 3v5c0 5-8 10-8 10S4 16 4 11V6l8-3Z',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  plus: 'M12 4v16M4 12h16',
  sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm0-6v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',
  smile: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20ZM8 9h.01M16 9h.01M8 14q4 5 8 0',
  image: 'M3 3h18v18H3V3Zm0 14 5-5 4 4 3-3 6 6M15 7h.01',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z',
};
export type IconName = keyof typeof paths;
export function CozyIcon({ name }: { name: IconName }) {
  return (
    <svg
      className="cozy-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
