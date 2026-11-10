// The display-preference keys and the <head> boot script — a plain module (no "use client"), so the server layout can
// inline the script's text (lib/displayPrefs.ts is the client hook that reads and writes the same keys).

export const PREFS_KEYS = { theme: "aud-theme", density: "aud-density" } as const;

/** Runs in <head> before the first paint (layout.tsx), so a dark page never flashes light */
export const PREFS_BOOT_SCRIPT =
  `try{var d=document.documentElement,t=localStorage.getItem("${PREFS_KEYS.theme}"),n=localStorage.getItem("${PREFS_KEYS.density}");` +
  `if(t==="dark"||t==="system")d.dataset.theme=t;if(n==="compact")d.dataset.density="compact"}catch(e){}`;
