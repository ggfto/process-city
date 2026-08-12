import type { Proc, Snapshot } from './types';

/**
 * Gerador sintetico: permite desenvolver a cidade sem o agent rodando.
 * Simula variacao de cpu/mem, picos de rede e nascimento/morte de processos.
 */

const NAMES = [
  ['systemd', 'root'], ['dockerd', 'root'], ['containerd', 'root'], ['nginx', 'www-data'],
  ['postgres', 'postgres'], ['redis-server', 'redis'], ['node', 'app'], ['python3', 'app'],
  ['java', 'app'], ['code', 'dev'], ['firefox', 'dev'], ['chrome', 'dev'],
  ['sshd', 'root'], ['cron', 'root'], ['rsyslogd', 'syslog'], ['mysqld', 'mysql'],
  ['php-fpm', 'www-data'], ['gunicorn', 'app'], ['ffmpeg', 'media'], ['rustc', 'dev'],
];

interface Sim extends Proc { phase: number; drift: number; }

const state = new Map<number, Sim>();
let nextPid = 1000;
let seeded = false;

function rnd(a: number, b: number): number { return a + Math.random() * (b - a); }

function spawn(): Sim {
  const [name, user] = NAMES[Math.floor(Math.random() * NAMES.length)];
  const pid = ++nextPid;
  return {
    pid,
    name,
    user,
    cpu: rnd(0, 25),
    rss: rnd(8, 1800) * 1024 * 1024,
    threads: Math.floor(rnd(1, 40)),
    status: 'running',
    uptime: Math.floor(rnd(60, 400000)),
    conns: Math.floor(rnd(0, 20)),
    io: 0,
    net: 0,
    phase: Math.random() * Math.PI * 2,
    drift: rnd(0.3, 1.7),
  };
}

export function mockSnapshot(): Snapshot {
  if (!seeded) {
    for (let i = 0; i < 120; i++) { const p = spawn(); state.set(p.pid, p); }
    seeded = true;
  }

  // churn: alguns morrem, outros nascem
  if (Math.random() < 0.35) {
    const keys = [...state.keys()];
    state.delete(keys[Math.floor(Math.random() * keys.length)]);
  }
  if (Math.random() < 0.4) { const p = spawn(); state.set(p.pid, p); }

  const now = Date.now() / 1000;
  const procs: Proc[] = [];
  let netTotal = 0;

  for (const p of state.values()) {
    p.phase += 0.12 * p.drift;
    const wave = (Math.sin(p.phase) + 1) / 2;
    p.cpu = Math.max(0, Math.min(180, p.cpu * 0.7 + wave * 45 * p.drift * 0.7 + rnd(-3, 3)));
    p.rss = Math.max(4e6, p.rss * rnd(0.995, 1.006));
    p.io = Math.max(0, wave * 4e6 * p.drift + rnd(-1e5, 3e5));
    p.net = Math.max(0, p.conns * rnd(0, 90_000) * (wave + 0.2));
    p.uptime += 1;
    netTotal += p.net;
    const { phase: _p, drift: _d, ...rest } = p;
    procs.push({ ...rest });
  }

  procs.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
  const memUsed = procs.reduce((s, p) => s + p.rss, 0);

  return {
    t: now,
    host: {
      procs: procs.length + 58,
      shown: procs.length,
      cpu: Math.min(100, procs.reduce((s, p) => s + p.cpu, 0) / 8),
      ncpu: 8,
      mem_used: memUsed,
      mem_total: 16 * 1024 ** 3,
      net_rx: netTotal * 0.7,
      net_tx: netTotal * 0.3,
      boot: now - 340000,
    },
    procs,
  };
}
