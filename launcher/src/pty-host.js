// launcher/src/pty-host.js — spawn `claude` under a PTY + transparent passthrough. resize() is
// guarded after exit: node-pty throws an UNCAUGHT "Cannot resize a pty that has already exited"
// on Node 22+/Windows (node-pty #827). `spawn` injected for tests.
export function createPtyHost({ file, args, cols, rows, cwd, env, spawn, sink, onExit, onData }) {
  const pty = spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
  let exited = false;
  pty.onData((d) => { sink(d); onData(d); });
  pty.onExit((e) => { exited = true; onExit(e && typeof e.exitCode === 'number' ? e.exitCode : 0); });
  return {
    pty,
    write: (d) => { try { pty.write(d); } catch { /* exited */ } },
    resize: (c, r) => { if (exited) return; try { pty.resize(c, r); } catch { /* raced exit */ } },
    kill: () => { try { pty.kill(); } catch { /* gone */ } },
  };
}
