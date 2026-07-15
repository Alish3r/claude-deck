// plugin/src/compact-router.js — decide where a model-dial PRESS sends /compact.
// Priority: the CLI session whose launcher is a DESCENDANT of the foreground terminal >
// (foreground is a terminal but no match => REFUSE, never compact the bridge) >
// foreground is not a terminal & a chat is active => bridge > sole live CLI > none.
import { isDescendant } from './proctree.js';
export function pickCompactRoute({ fg, cliMarkers = [], bridgeActive = false }) {
  const live = cliMarkers.filter((m) => m && m.alive);
  if (fg && fg.pid != null) {
    const hit = live.find((m) => m.pid === fg.pid || isDescendant(m.pid, fg.pid, fg.parents || {}));
    if (hit) return { via: 'cli', id: hit.id };
    if (fg.isTerminal) return { via: 'none' };   // a terminal is focused but no Claude under it — refuse, don't compact VS Code
  }
  if (bridgeActive) return { via: 'bridge' };
  if (live.length === 1) return { via: 'cli', id: live[0].id };
  return { via: 'none' };
}
