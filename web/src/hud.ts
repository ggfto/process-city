import * as THREE from 'three';
import type { City } from './city';
import { cpuNorm, ramp } from './city';
import type { LinkState } from './net';
import type { Proc, Snapshot } from './types';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const fmtBytes = (b: number): string => {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b.toFixed(0)} B`;
};

const fmtRate = (b: number): string => `${fmtBytes(b)}/s`;

const fmtUptime = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export class Hud {
  private snap?: Snapshot;
  private selected: number | null = null;
  private tags = new Map<number, HTMLElement>();
  private v = new THREE.Vector3();
  private color = new THREE.Color();

  constructor(
    private city: City,
    private camera: THREE.Camera,
    private onPick: (pid: number) => void,
  ) {}

  setLink(state: LinkState): void {
    const el = $('s-link');
    el.textContent = state === 'live' ? 'LIVE' : state === 'mock' ? 'DEMO' : '...';
    el.className = state === 'live' ? 'c-green' : state === 'mock' ? 'c-amber' : 'c-cyan';
  }

  setSnapshot(s: Snapshot): void {
    this.snap = s;
    const h = s.host;

    $('s-procs').textContent = String(h.procs);
    $('s-cpu').textContent = `${h.cpu.toFixed(0)}%`;
    $('s-mem').textContent = `${fmtBytes(h.mem_used)} / ${fmtBytes(h.mem_total)}`;
    $('s-net').textContent = fmtRate(h.net_rx + h.net_tx);
    $('s-link').title = h.sample_ms ? `coleta: ${h.sample_ms} ms · ${h.shown}/${h.procs} processos` : '';

    this.renderTop(s.procs.slice(0, 5));
    if (this.selected !== null) this.renderDetails(s.procs.find((p) => p.pid === this.selected) ?? null);
  }

  private renderTop(top: Proc[]): void {
    const max = Math.max(1, ...top.map((p) => p.cpu));
    const ol = $('top');
    ol.innerHTML = '';
    top.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'row';
      const c = ramp(cpuNorm(p.cpu), this.color).getStyle();
      li.innerHTML = `
        <span class="idx">${i + 1}.</span>
        <span class="nm">${p.name}</span>
        <span class="val">${p.cpu.toFixed(0)}%</span>
        <span></span>
        <span class="bar" style="color:${c}"><i style="width:${(p.cpu / max) * 100}%"></i></span>
        <span></span>`;
      li.onclick = () => this.onPick(p.pid);
      ol.appendChild(li);
    });
  }

  setSelected(pid: number | null): void {
    this.selected = pid;
    this.renderDetails(pid === null ? null : this.snap?.procs.find((p) => p.pid === pid) ?? null);
  }

  private renderDetails(p: Proc | null): void {
    const set = (id: string, v: string) => { $(id).textContent = v; };
    if (!p) {
      ['d-name', 'd-pid', 'd-user', 'd-cpu', 'd-mem', 'd-thr', 'd-net', 'd-io', 'd-status', 'd-up']
        .forEach((id) => set(id, '—'));
      return;
    }
    set('d-name', p.name);
    set('d-pid', String(p.pid));
    set('d-user', p.user);
    set('d-cpu', `${p.cpu.toFixed(1)}%`);
    set('d-mem', fmtBytes(p.rss));
    set('d-thr', String(p.threads));
    set('d-net', fmtRate(p.net));
    set('d-io', fmtRate(p.io));
    set('d-status', p.status);
    set('d-up', fmtUptime(p.uptime));
  }

  /** Rotulos flutuantes ancorados no topo dos predios (top 6 + selecionado). */
  tickLabels(w: number, h: number): void {
    if (!this.snap) return;
    const wanted = new Set<number>();
    const list = this.snap.procs.slice(0, 6).map((p) => p.pid);
    if (this.selected !== null && !list.includes(this.selected)) list.push(this.selected);

    const placed: Array<[number, number]> = []; // rotulos ja posicionados

    for (const pid of list) {
      const proc = this.snap.procs.find((p) => p.pid === pid);
      if (!proc || !this.city.topOf(pid, this.v)) continue;
      wanted.add(pid);

      let el = this.tags.get(pid);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tag';
        el.onclick = () => this.onPick(pid);
        $('labels').appendChild(el);
        this.tags.set(pid, el);
      }

      el.innerHTML = `<b>${proc.name}</b><em>CPU: ${proc.cpu.toFixed(0)}%</em> <i>MEM: ${fmtBytes(proc.rss)}</i>`;
      el.classList.toggle('sel', pid === this.selected);

      this.v.project(this.camera);
      const behind = this.v.z > 1;
      el.style.opacity = behind ? '0' : '1';

      const px = (this.v.x * 0.5 + 0.5) * w;
      let py = (-this.v.y * 0.5 + 0.5) * h;
      // empilha em vez de sobrepor: os processos mais pesados costumam ficar
      // no mesmo distrito, entao os rotulos nascem uns em cima dos outros
      for (let guard = 0; guard < 3; guard++) {
        const clash = placed.some(([qx, qy]) => Math.abs(qx - px) < 170 && Math.abs(qy - py) < 44);
        if (!clash) break;
        py -= 46;
      }
      placed.push([px, py]);

      el.style.left = `${px}px`;
      el.style.top = `${py}px`;
    }

    for (const [pid, el] of this.tags) {
      if (!wanted.has(pid)) { el.remove(); this.tags.delete(pid); }
    }
  }
}
