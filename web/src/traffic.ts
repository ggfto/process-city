import * as THREE from 'three';
import { BLOCK, CELL, GRID, cellToWorld } from './layout';

const MAX_CARS = 900;
const AXIS_Y = new THREE.Vector3(0, 1, 0);

interface Car {
  axis: 0 | 1;   // 0 = corre em X, 1 = corre em Z
  fixed: number; // coordenada da rua
  t: number;     // posicao ao longo da via, em unidades de mundo
  dir: 1 | -1;
  speed: number;
  up: boolean;   // true = upload (tx), false = download (rx)
}

/**
 * Trafego = I/O de rede. A densidade e a velocidade das particulas nas ruas
 * seguem o throughput do host; cor separa rx (ciano) de tx (ambar).
 */
export class Traffic {
  readonly mesh: THREE.InstancedMesh;
  private cars: Car[] = [];
  private lanes: number[] = [];
  private active = 0;
  private target = 0;
  private extent = (GRID * CELL) / 2;
  private cx = 0;
  private cz = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private pos = new THREE.Vector3();
  private scl = new THREE.Vector3(1, 1, 1);
  private rx = new THREE.Color('#7ef2ff');
  private tx = new THREE.Color('#ffc871');
  private speedScale = 1;

  constructor() {
    const geo = new THREE.BoxGeometry(0.16, 0.12, 1.8);
    // three so aplica a cor por instancia no fragment quando USE_COLOR esta
    // ligado (vertexColors), e ai exige o atributo `color` -- sem ele o
    // atributo desabilitado vale (0,0,0) e todo carro sai preto.
    const white = new Float32Array(geo.attributes.position.count * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(white, 3));

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      toneMapped: false,
      transparent: true,
      opacity: 0.95,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_CARS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;

    // ruas disponiveis (coordenada fixa de cada via)
    for (let c = BLOCK - 1; c < GRID; c += BLOCK) this.lanes.push(cellToWorld(c, 0)[0]);

    for (let i = 0; i < MAX_CARS; i++) {
      const axis: 0 | 1 = i % 2 === 0 ? 0 : 1;
      const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      const lane = this.lanes[Math.floor(Math.random() * this.lanes.length)];
      const up = Math.random() < 0.35;
      this.cars.push({
        axis,
        fixed: lane + dir * CELL * 0.14, // mao dupla: cada sentido na sua faixa
        t: (Math.random() * 2 - 1) * this.extent,
        dir,
        speed: 6 + Math.random() * 10,
        up,
      });
      this.mesh.setColorAt(i, up ? this.tx : this.rx);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this.m4.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_CARS; i++) this.mesh.setMatrixAt(i, this.m4);
  }

  /** bytes/s totais do host -> densidade/velocidade do trafego */
  setThroughput(bytesPerSec: number): void {
    const n = Math.min(1, Math.log10(bytesPerSec / 1024 + 1) / 5); // ~0..100 MB/s
    this.target = Math.floor(30 + n * (MAX_CARS - 30));
    this.speedScale = 0.45 + n * 2.2;
  }

  /**
   * Confina o trafego a mancha urbana: espalhado pela grade inteira ele vira
   * ruido brilhante em volta de uma cidade pequena.
   */
  setArea(cx: number, cz: number, r: number): void {
    this.cx = cx;
    this.cz = cz;
    this.extent = Math.max(20, r * 1.1);

    // vias que cruzam a cidade em cada eixo
    const poolZ = this.lanes.filter((v) => Math.abs(v - cz) <= this.extent);
    const poolX = this.lanes.filter((v) => Math.abs(v - cx) <= this.extent);

    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      const pool = c.axis === 0 ? poolZ : poolX;
      if (!pool.length) continue;
      c.fixed = pool[i % pool.length] + c.dir * CELL * 0.14;
    }
  }

  tick(dt: number): void {
    // converge a quantidade de carros suavemente
    this.active += (this.target - this.active) * Math.min(1, dt * 2);
    const count = Math.round(this.active);

    for (let i = 0; i < MAX_CARS; i++) {
      if (i >= count) {
        this.m4.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m4);
        continue;
      }
      const c = this.cars[i];
      const center = c.axis === 0 ? this.cx : this.cz;
      c.t += c.dir * c.speed * this.speedScale * dt;
      if (c.t > center + this.extent) c.t = center - this.extent;
      if (c.t < center - this.extent) c.t = center + this.extent;

      if (c.axis === 0) {
        this.pos.set(c.t, 0.16, c.fixed);
        this.q.setFromAxisAngle(AXIS_Y, Math.PI / 2);
      } else {
        this.pos.set(c.fixed, 0.16, c.t);
        this.q.identity();
      }
      // rastro mais longo quando o trafego esta rapido
      this.scl.set(1, 1, 0.6 + this.speedScale * 0.4);
      this.m4.compose(this.pos, this.q, this.scl);
      this.mesh.setMatrixAt(i, this.m4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
