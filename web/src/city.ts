import * as THREE from 'three';
import type { Proc, Snapshot } from './types';
import { CELL, LotAllocator, cellToWorld, unkey } from './layout';

const MAX = 1200;               // teto de predios instanciados
const LERP = 3.2;               // velocidade de convergencia das animacoes

/** Rampa de cor por CPU: azul frio -> ciano -> magenta -> laranja quente. */
const RAMP: [number, THREE.Color][] = [
  [0.00, new THREE.Color('#1a6fc4')],
  [0.18, new THREE.Color('#17b6ff')],
  [0.45, new THREE.Color('#8b4dff')],
  [0.70, new THREE.Color('#ff3fb0')],
  [1.00, new THREE.Color('#ff8a2b')],
];

function ramp(t: number, out: THREE.Color): THREE.Color {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const [t0, c0] = RAMP[i - 1];
      const [t1, c1] = RAMP[i];
      return out.copy(c0).lerp(c1, (t - t0) / (t1 - t0));
    }
  }
  return out.copy(RAMP[RAMP.length - 1][1]);
}

interface Entry {
  pid: number;
  proc: Proc;
  slot: number;
  lot: number;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;        // altura atual (animada)
  ht: number;       // altura alvo
  act: number;      // atividade atual
  actT: number;     // atividade alvo
  jitter: number;   // variacao estavel derivada do pid
  color: THREE.Color;
  target: THREE.Color;
  dying: boolean;
}

/** Acima desta altura o predio ganha mastro em vez de coroa achatada. */
const TOWER_H = 17;

const bytesToMB = (b: number) => b / (1024 * 1024);

/** CPU% -> posicao na rampa de cor (mesma curva no HUD e na cidade) */
export const cpuNorm = (cpu: number): number => Math.sqrt(Math.min(cpu / 100, 1));

export class City {
  readonly group = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;

  private lots = new LotAllocator();
  private byPid = new Map<number, Entry>();
  private bySlot: (Entry | null)[] = new Array(MAX).fill(null);
  private freeSlots: number[] = [];
  private aAct: THREE.InstancedBufferAttribute;
  private aTint: THREE.InstancedBufferAttribute;
  private capAct: THREE.InstancedBufferAttribute;
  private capTint: THREE.InstancedBufferAttribute;
  private poolAct: THREE.InstancedBufferAttribute;
  private poolTint: THREE.InstancedBufferAttribute;
  private caps: THREE.InstancedMesh;
  /** discos aditivos: precisam ficar fora do g-buffer do AO */
  readonly pools: THREE.InstancedMesh;
  private uTime = { value: 0 };
  private m4 = new THREE.Matrix4();

  constructor() {
    for (let i = MAX - 1; i >= 0; i--) this.freeSlots.push(i);

    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0); // base no y=0

    this.aAct = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    geo.setAttribute('aActivity', this.aAct);
    geo.setAttribute('aTint', this.aTint);

    const mat = new THREE.MeshStandardMaterial({
      color: 0x151f36,
      roughness: 0.48,
      metalness: 0.45,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          attribute float aActivity;
          attribute vec3 aTint;
          varying float vAct;
          varying vec3 vTint;
          varying vec3 vLocal;
          varying vec3 vScl;
          varying vec3 vObjN;
        `)
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          vAct = aActivity;
          vTint = aTint;
          vLocal = position;
          // normal em espaco de OBJETO: vNormal e' view-space, e classificar
          // as faces com ela faz o padrao de janelas girar junto com a camera
          vObjN = normal;
          vScl = vec3(
            length(instanceMatrix[0].xyz),
            length(instanceMatrix[1].xyz),
            length(instanceMatrix[2].xyz)
          );
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform float uTime;
          varying float vAct;
          varying vec3 vTint;
          varying vec3 vLocal;
          varying vec3 vScl;
          varying vec3 vObjN;
          float hash21(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
          }
        `)
        .replace('#include <color_fragment>', /* glsl */`
          #include <color_fragment>
          diffuseColor.rgb = mix(diffuseColor.rgb, vTint * 0.22, 0.55);
        `)
        .replace('#include <emissivemap_fragment>', /* glsl */`
          #include <emissivemap_fragment>
          vec3 nn = normalize(vObjN);
          if (abs(nn.y) < 0.5) {
            // coordenada em unidades de MUNDO -> janelas do mesmo tamanho
            // independente da escala do predio
            vec2 uvw = abs(nn.x) > abs(nn.z)
              ? vec2(vLocal.z * vScl.z, vLocal.y * vScl.y)
              : vec2(vLocal.x * vScl.x, vLocal.y * vScl.y);
            vec2 cellSize = vec2(0.60, 0.74);
            vec2 g = fract(uvw / cellSize);
            vec2 id = floor(uvw / cellSize);
            float win = step(0.24, g.x) * step(g.x, 0.76)
                      * step(0.22, g.y) * step(g.y, 0.72);
            // andar tecnico a cada 7 pavimentos: quebra a grade perfeita que
            // denuncia textura procedural
            float andar = floor(uvw.y / cellSize.y);
            win *= 1.0 - step(6.5, mod(andar, 7.0));

            float h = hash21(id + 0.37);
            // piso de 32% de janelas acesas: processo ocioso ainda e' um
            // predio habitado, so nao pulsa
            float lit = step(1.0 - (0.32 + 0.58 * vAct), h);
            float flick = 0.78 + 0.22 * sin(uTime * (1.5 + 7.0 * vAct) + h * 63.0);
            // janela puxada pro branco: a cor pura do tint e' escura demais
            // pra ler como luz acesa contra a fachada
            vec3 lampada = mix(vTint, vec3(1.0), 0.15);
            totalEmissiveRadiance += lampada * win * lit * flick * (0.45 + 1.7 * vAct);

            // terreo sempre aceso: ancora visualmente o predio no asfalto
            float lobby = step(0.05, uvw.y) * (1.0 - step(cellSize.y * 0.85, uvw.y));
            totalEmissiveRadiance += lampada * lobby * 0.45;
          } else {
            // luz de topo (sinalizacao) pulsando com a atividade
            totalEmissiveRadiance += vTint * vAct * (0.18 + 0.18 * sin(uTime * 3.0));
          }
          // realce de silhueta: aqui a normal certa e' a de view-space
          float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 3.0);
          totalEmissiveRadiance += vTint * rim * 0.35;
        `);
    };

    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.group.add(this.mesh);

    // ---- coroas / mastros: caixa pura tem silhueta morta ----
    const capGeo = new THREE.BoxGeometry(1, 1, 1);
    capGeo.translate(0, 0.5, 0);
    this.capAct = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    this.capTint = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    capGeo.setAttribute('aActivity', this.capAct);
    capGeo.setAttribute('aTint', this.capTint);
    this.caps = new THREE.InstancedMesh(capGeo, this.makeCapMaterial(), MAX);
    this.caps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.caps.frustumCulled = false;
    this.group.add(this.caps);

    // ---- pocas de luz: o predio precisa iluminar o asfalto embaixo dele ----
    const poolGeo = new THREE.PlaneGeometry(1, 1);
    poolGeo.rotateX(-Math.PI / 2);
    this.poolAct = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    this.poolTint = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    poolGeo.setAttribute('aActivity', this.poolAct);
    poolGeo.setAttribute('aTint', this.poolTint);
    this.pools = new THREE.InstancedMesh(poolGeo, this.makePoolMaterial(), MAX);
    this.pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pools.frustumCulled = false;
    this.pools.renderOrder = 1;
    this.group.add(this.pools);

    // todos os slots comecam escondidos
    this.m4.makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) {
      this.mesh.setMatrixAt(i, this.m4);
      this.caps.setMatrixAt(i, this.m4);
      this.pools.setMatrixAt(i, this.m4);
    }
  }

  /** Metal escuro com aresta acesa e baliza piscando no topo. */
  private makeCapMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0b1220,
      roughness: 0.35,
      metalness: 0.75,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          attribute float aActivity;
          attribute vec3 aTint;
          varying float vAct;
          varying vec3 vTint;
          varying vec3 vObjN;
          varying float vLargura;
        `)
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          vAct = aActivity;
          vTint = aTint;
          vObjN = normal;
          vLargura = length(instanceMatrix[0].xyz);
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform float uTime;
          varying float vAct;
          varying vec3 vTint;
          varying vec3 vObjN;
          varying float vLargura;
        `)
        .replace('#include <emissivemap_fragment>', /* glsl */`
          #include <emissivemap_fragment>
          float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 2.0);
          totalEmissiveRadiance += vTint * rim * 0.35;
          // baliza so no mastro das torres: no topo largo ela vira telhado
          // vermelho em vez de ponto de luz
          float mastro = 1.0 - step(1.0, vLargura);
          if (vObjN.y > 0.5 && mastro > 0.5) {
            float beacon = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * (1.6 + 4.0 * vAct)), 3.0);
            totalEmissiveRadiance += vec3(1.0, 0.22, 0.16) * beacon * 2.2;
          }
        `);
    };
    return mat;
  }

  /** Disco aditivo no asfalto, com raio e forca ligados a atividade. */
  private makePoolMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {},
      vertexShader: /* glsl */`
        attribute float aActivity;
        attribute vec3 aTint;
        varying float vAct;
        varying vec3 vTint;
        varying vec2 vUv2;
        void main() {
          vAct = aActivity;
          vTint = aTint;
          vUv2 = uv;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        varying float vAct;
        varying vec3 vTint;
        varying vec2 vUv2;
        void main() {
          float d = length(vUv2 - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.0, d);
          a *= a;
          gl_FragColor = vec4(vTint * a * (0.07 + 0.42 * vAct), a * 0.8);
        }
      `,
    });
  }

  // ------------------------------------------------------------------ //
  private targets(p: Proc): { ht: number; act: number; color: THREE.Color } {
    // altura: log da memoria residente (senao um processo de 4 GB some com o resto)
    const ht = Math.log10(bytesToMB(p.rss) + 1) * 7.8 + 1.5;
    // curva perceptual: linear em %, quase tudo cairia no azul do inicio da
    // rampa (a maioria dos processos vive abaixo de 5% de CPU)
    const cpuN = cpuNorm(p.cpu);
    const ioN = Math.min(p.io / 8e6, 1);
    const netN = Math.min(p.net / 4e6, 1);
    const act = Math.min(1, cpuN * 0.62 + ioN * 0.2 + netN * 0.18);
    return { ht, act, color: ramp(cpuN, new THREE.Color()) };
  }

  update(snap: Snapshot): void {
    const seen = new Set<number>();

    for (const p of snap.procs) {
      seen.add(p.pid);
      let e = this.byPid.get(p.pid);

      if (!e) {
        const slot = this.freeSlots.pop();
        if (slot === undefined) continue;      // cidade cheia
        const lot = this.lots.claim(p.user);
        if (lot === null) { this.freeSlots.push(slot); continue; }
        const [cx, cz] = unkey(lot);
        const [x, z] = cellToWorld(cx, cz);
        const jitter = ((p.pid * 2654435761) % 1000) / 1000;
        e = {
          pid: p.pid, proc: p, slot, lot, x, z,
          w: CELL * (0.70 + jitter * 0.14),
          d: CELL * (0.70 + (1 - jitter) * 0.14),
          h: 0, ht: 0, act: 0, actT: 0, jitter,
          color: new THREE.Color('#0a3f7a'),
          target: new THREE.Color('#0a3f7a'),
          dying: false,
        };
        this.byPid.set(p.pid, e);
        this.bySlot[slot] = e;
      }

      const t = this.targets(p);
      e.proc = p;
      e.ht = t.ht;
      e.actT = t.act;
      e.target.copy(t.color);
      e.dying = false;
    }

    // sumiu do snapshot => processo morreu: predio afunda e libera o lote
    for (const e of this.byPid.values()) if (!seen.has(e.pid)) { e.dying = true; e.ht = 0; e.actT = 0; }
  }

  tick(dt: number, time: number): void {
    this.uTime.value = time;
    const k = 1 - Math.exp(-dt * LERP);
    const acts = this.aAct.array as Float32Array;
    const tints = this.aTint.array as Float32Array;
    const capActs = this.capAct.array as Float32Array;
    const capTints = this.capTint.array as Float32Array;
    const poolActs = this.poolAct.array as Float32Array;
    const poolTints = this.poolTint.array as Float32Array;

    for (const e of [...this.byPid.values()]) {
      e.h += (e.ht - e.h) * k;
      e.act += (e.actT - e.act) * k;
      e.color.lerp(e.target, k);

      if (e.dying && e.h < 0.06) {
        this.m4.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(e.slot, this.m4);
        this.caps.setMatrixAt(e.slot, this.m4);
        this.pools.setMatrixAt(e.slot, this.m4);
        this.bySlot[e.slot] = null;
        this.freeSlots.push(e.slot);
        this.lots.release(e.lot);
        this.byPid.delete(e.pid);
        continue;
      }

      const h = Math.max(e.h, 0.001);
      this.m4.makeScale(e.w, h, e.d);
      this.m4.setPosition(e.x, 0, e.z);
      this.mesh.setMatrixAt(e.slot, this.m4);

      // torre alta ganha mastro fino; predio baixo, uma coroa levemente
      // saliente (casa de maquinas)
      const tower = e.ht > TOWER_H;
      const capW = tower ? e.w * 0.22 : e.w * 0.88;
      const capD = tower ? e.d * 0.22 : e.d * 0.88;
      const capH = tower ? 2.0 + e.jitter * 2.6 : 0.28 + e.jitter * 0.4;
      this.m4.makeScale(capW, capH * Math.min(1, e.h / 2), capD);
      this.m4.setPosition(e.x, h, e.z);
      this.caps.setMatrixAt(e.slot, this.m4);

      const spread = Math.max(e.w, e.d) * (2.6 + e.act * 1.6);
      this.m4.makeScale(spread, 1, spread);
      this.m4.setPosition(e.x, 0.03, e.z);
      this.pools.setMatrixAt(e.slot, this.m4);

      acts[e.slot] = capActs[e.slot] = poolActs[e.slot] = e.act;
      for (let c = 0; c < 3; c++) {
        const v = c === 0 ? e.color.r : c === 1 ? e.color.g : e.color.b;
        tints[e.slot * 3 + c] = v;
        capTints[e.slot * 3 + c] = v;
        poolTints[e.slot * 3 + c] = v;
      }
    }

    for (const m of [this.mesh, this.caps, this.pools]) m.instanceMatrix.needsUpdate = true;
    for (const a of [this.aAct, this.aTint, this.capAct, this.capTint,
                     this.poolAct, this.poolTint]) a.needsUpdate = true;
  }

  // ------------------------------------------------------------------ //
  procAt(instanceId: number): Proc | null {
    return this.bySlot[instanceId]?.proc ?? null;
  }

  /** Posicao do topo do predio (para ancorar rotulos na tela). */
  topOf(pid: number, out: THREE.Vector3): boolean {
    const e = this.byPid.get(pid);
    if (!e) return false;
    out.set(e.x, e.h + 1.2, e.z);
    return true;
  }

  boxOf(pid: number): { x: number; z: number; w: number; d: number; h: number } | null {
    const e = this.byPid.get(pid);
    return e ? { x: e.x, z: e.z, w: e.w, d: e.d, h: e.h } : null;
  }

  has(pid: number): boolean {
    return this.byPid.has(pid);
  }

  /** Centro e raio da mancha urbana ocupada -- usado pra enquadrar a camera. */
  bounds(): { cx: number; cz: number; radius: number; top: number } {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, top = 0;
    for (const e of this.byPid.values()) {
      if (e.x < minX) minX = e.x;
      if (e.x > maxX) maxX = e.x;
      if (e.z < minZ) minZ = e.z;
      if (e.z > maxZ) maxZ = e.z;
      if (e.ht > top) top = e.ht;
    }
    if (minX === Infinity) return { cx: 0, cz: 0, radius: 40, top: 20 };
    return {
      cx: (minX + maxX) / 2,
      cz: (minZ + maxZ) / 2,
      radius: Math.max(20, Math.hypot(maxX - minX, maxZ - minZ) / 2),
      top,
    };
  }
}

export { ramp };
