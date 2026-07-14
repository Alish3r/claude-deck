// The ⊙GLOBAL effort ladder, low → high. Node-free so it can be imported in the browser
// (the mockup) and in the pure LCD renderer without pulling in fs.
// low…max are the extension's own effortLevel values (its enum: low|medium|high|xhigh|max);
// 'ultracode' (top) = xhigh + the ultracode flag, matching the extension's definition
// ("Ultracode - xhigh + workflows"). There is deliberately NO 'auto' rung: the Claude Code
// effort picker has no Auto entry, so it isn't a dialable position — an ABSENT settings
// key still READS as 'auto' (display-only; the LCD shows it, browsing from it starts at
// low, and resolveEffort keeps accepting it for the CLI).
export const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
