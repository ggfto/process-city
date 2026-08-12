/**
 * Malha urbana e alocacao de lotes.
 *
 * O ponto critico da visualizacao e' estabilidade espacial: o predio de um PID
 * nao pode pular de lugar entre snapshots, senao a cidade "ferve" e vira ruido.
 * Por isso:
 *   - a grade e' fixa (celulas construiveis + ruas a cada BLOCK celulas);
 *   - cada usuario ganha uma ancora deterministica (hash do nome) -> distritos;
 *   - um processo novo pega o lote LIVRE mais proximo da ancora do seu usuario;
 *   - o lote so volta pro pool quando o processo morre.
 */

export const CELL = 3.2;   // largura de uma celula, em unidades de mundo
export const BLOCK = 5;    // 4 lotes + 1 rua
export const GRID = 61;    // grade GRID x GRID
const HALF = (GRID - 1) / 2;

export const isStreet = (cx: number, cz: number): boolean =>
  cx % BLOCK === BLOCK - 1 || cz % BLOCK === BLOCK - 1;

export const key = (cx: number, cz: number): number => cx * GRID + cz;
export const unkey = (k: number): [number, number] => [Math.floor(k / GRID), k % GRID];

export function cellToWorld(cx: number, cz: number): [number, number] {
  return [(cx - HALF) * CELL, (cz - HALF) * CELL];
}

/** hash estavel string -> [0,1) */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export class LotAllocator {
  private free = new Set<number>();
  private anchors = new Map<string, [number, number]>();

  constructor() {
    for (let cx = 0; cx < GRID; cx++) {
      for (let cz = 0; cz < GRID; cz++) {
        if (!isStreet(cx, cz)) this.free.add(key(cx, cz));
      }
    }
  }

  /** Centro do distrito de um usuario: polar deterministico a partir do nome. */
  private anchor(user: string): [number, number] {
    let a = this.anchors.get(user);
    if (a) return a;
    const t = hash01(user);
    const t2 = hash01(user + '#r');
    const ang = t * Math.PI * 2;
    // root/system ficam no centro (downtown), usuarios comuns nos aneis
    // externos -- raios curtos porque host pequeno com distritos espalhados
    // vira punhado de predios perdidos numa grade gigante
    const core = user === 'root' || user === 'SYSTEM' || user === 'system';
    const rad = core ? 1.5 + t2 * 3.5 : 5 + t2 * 10;
    a = [
      Math.round(HALF + Math.cos(ang) * rad),
      Math.round(HALF + Math.sin(ang) * rad),
    ];
    this.anchors.set(user, a);
    return a;
  }

  /** Lote livre mais proximo da ancora do usuario (busca em aneis). */
  claim(user: string): number | null {
    const [ax, az] = this.anchor(user);
    for (let r = 0; r < GRID; r++) {
      const found = this.scanRing(ax, az, r);
      if (found !== null) {
        this.free.delete(found);
        return found;
      }
    }
    return null; // cidade lotada
  }

  private scanRing(ax: number, az: number, r: number): number | null {
    const test = (cx: number, cz: number): number | null => {
      if (cx < 0 || cz < 0 || cx >= GRID || cz >= GRID) return null;
      const k = key(cx, cz);
      return this.free.has(k) ? k : null;
    };
    if (r === 0) return test(ax, az);
    for (let d = -r; d <= r; d++) {
      const hits = [
        test(ax + d, az - r), test(ax + d, az + r),
        test(ax - r, az + d), test(ax + r, az + d),
      ];
      for (const h of hits) if (h !== null) return h;
    }
    return null;
  }

  release(k: number): void {
    this.free.add(k);
  }
}
