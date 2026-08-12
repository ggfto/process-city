import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GradeShader } from './grade';

import { City } from './city';
import { makeGround } from './ground';
import { Hud } from './hud';
import { Feed, resolveUrl } from './net';
import { Traffic } from './traffic';
import type { Snapshot } from './types';

const canvas = document.getElementById('scene') as HTMLCanvasElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#04050d');
scene.fog = new THREE.FogExp2('#04050d', 0.0055);

// domo de gradiente: contra preto chapado a silhueta da cidade nao tem
// contra-forma e o skyline some
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(900, 24, 12),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uBaixo: { value: new THREE.Color('#0a1430') },
      uAlto: { value: new THREE.Color('#03040b') },
    },
    vertexShader: /* glsl */`
      varying float vAltura;
      void main() {
        vec4 p = modelMatrix * vec4(position, 1.0);
        vAltura = normalize(p.xyz).y;
        gl_Position = projectionMatrix * viewMatrix * p;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uBaixo, uAlto;
      varying float vAltura;
      void main() {
        gl_FragColor = vec4(mix(uBaixo, uAlto, smoothstep(-0.05, 0.45, vAltura)), 1.0);
      }
    `,
  }),
);
sky.renderOrder = -2;
scene.add(sky);

const camera = new THREE.PerspectiveCamera(46, 1, 0.5, 2000);
camera.position.set(120, 95, 140);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.49;   // nao deixa entrar embaixo do chao
controls.minDistance = 12;
controls.maxDistance = 420;
controls.target.set(0, 8, 0);

// --- luz: cena noturna, quase tudo vem das janelas emissivas + bloom ------
// luz ambiente baixa: a massa do predio tem que ficar escura pra janela
// acesa ter contraste. O que ilumina a cena e' a propria cidade.
scene.add(new THREE.HemisphereLight(0x2c4f8c, 0x05060f, 0.45));
const key = new THREE.DirectionalLight(0x9bb8ff, 0.38);
key.position.set(60, 120, 40);
scene.add(key);

const city = new City();
const traffic = new Traffic();
const ground = makeGround();
scene.add(city.group, traffic.mesh, ground.mesh);

// contorno do predio selecionado
const outline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)),
  new THREE.LineBasicMaterial({ color: 0xffb648, toneMapped: false }),
);
outline.visible = false;
scene.add(outline);

// --- pos-processamento: o glow ------------------------------------------
// o antialias do renderer nao vale nada com EffectComposer: o RenderPass
// desenha num render target proprio. Precisa ser um target multisample.
const rt = new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType,
  samples: 4,
});
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));

// ?fx=low desliga o AO (a passagem mais cara) pra maquina fraca/telao antigo
const FX_LOW = new URLSearchParams(location.search).get('fx') === 'low';

// oclusao de ambiente: sem ela os predios parecem adesivos colados no chao
const gtao = new GTAOPass(scene, camera, 1, 1);
// raio curto e mistura fraca de proposito: numa malha densa o AO ocluiria
// tudo, e o pass aplica a oclusao tambem sobre o emissivo das janelas
gtao.updateGtaoMaterial({ radius: 1.0, distanceExponent: 1.4, thickness: 0.8, scale: 1.0 });
gtao.blendIntensity = 0.4;
gtao.enabled = !FX_LOW;
composer.addPass(gtao);

// o GTAO desenha a cena inteira com overrideMaterial pra montar o g-buffer.
// Geometria aditiva (pocas de luz, trafego) nao tem superficie de verdade e
// so suja o buffer de normais -- escondemos durante essa passagem.
const semAO: THREE.Object3D[] = [city.pools, traffic.mesh];
const gtaoRender = gtao.render.bind(gtao);
gtao.render = (...args: Parameters<typeof gtaoRender>) => {
  for (const o of semAO) o.visible = false;
  gtaoRender(...args);
  for (const o of semAO) o.visible = true;
};

// threshold alto de proposito: abaixo de ~0.26 o bloom pega a malha do chao
// e a cidade inteira fica velada
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.9, 0.5, 0.3);
composer.addPass(bloom);

const grade = new ShaderPass(GradeShader);
composer.addPass(grade);
composer.addPass(new OutputPass());

// --- HUD + dados ---------------------------------------------------------
let selected: number | null = null;
const hud = new Hud(city, camera, (pid) => select(pid));

function select(pid: number | null): void {
  selected = pid;
  hud.setSelected(pid);
  if (pid === null) outline.visible = false;
}

const feed = new Feed(
  resolveUrl(),
  (snap: Snapshot) => { city.update(snap); traffic.setThroughput(snap.host.net_rx + snap.host.net_tx); hud.setSnapshot(snap); },
  (state) => hud.setLink(state),
);
feed.start();

// --- picking -------------------------------------------------------------
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
let downAt = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return; // foi orbit, nao clique
  ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(city.mesh, false)[0];
  const proc = hit?.instanceId !== undefined ? city.procAt(hit.instanceId) : null;
  select(proc ? proc.pid : null);
});

// --- resize --------------------------------------------------------------
function resize(): void {
  const w = innerWidth;
  const h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.setSize(w, h);
  gtao.setSize(w, h);
}
addEventListener('resize', resize);
resize();

// --- loop ----------------------------------------------------------------
const clock = new THREE.Clock();
let orbit = true;
addEventListener('keydown', (e) => { if (e.key === ' ') orbit = !orbit; });
canvas.addEventListener('pointerdown', () => { orbit = false; });

// a camera automatica segue a mancha urbana: como os distritos so ocupam
// parte da grade, enquadrar a grade inteira deixaria a cidade minuscula
const frame = { cx: 0, cz: 0, r: 60, top: 20 };
// ?zoom=0.5 aproxima a camera automatica (util pra kiosk/telao)
const ZOOM = Math.max(0.15, Number(new URLSearchParams(location.search).get('zoom')) || 1);
let lastArea = { cx: 1e9, cz: 1e9, r: 0 };

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;

  const b = city.bounds();
  const k = Math.min(1, dt * 0.8);
  frame.cx += (b.cx - frame.cx) * k;
  frame.cz += (b.cz - frame.cz) * k;
  frame.r += (b.radius - frame.r) * k;
  frame.top += (b.top - frame.top) * k;

  // reatribuir faixas custa; so refaz quando a mancha muda de verdade
  if (Math.hypot(frame.cx - lastArea.cx, frame.cz - lastArea.cz) > 2
      || Math.abs(frame.r - lastArea.r) > 2) {
    lastArea = { cx: frame.cx, cz: frame.cz, r: frame.r };
    ground.setArea(frame.cx, frame.cz, frame.r);
    traffic.setArea(frame.cx, frame.cz, frame.r);
  }

  if (orbit) {
    const a = t * 0.045;
    const dist = (frame.r * 1.35 + 20) * ZOOM;
    camera.position.set(
      frame.cx + Math.cos(a) * dist,
      frame.top * 1.4 + frame.r * 0.7,
      frame.cz + Math.sin(a) * dist,
    );
    controls.target.set(frame.cx, frame.top * 0.35, frame.cz);
    camera.lookAt(controls.target);
  }
  controls.update();

  city.tick(dt, t);
  traffic.tick(dt);

  if (selected !== null) {
    const b = city.boxOf(selected);
    if (b) {
      outline.visible = true;
      outline.position.set(b.x, 0, b.z);
      outline.scale.set(b.w * 1.12, b.h * 1.04 + 0.4, b.d * 1.12);
    } else {
      outline.visible = false; // processo morreu
      select(null);
    }
  }

  hud.tickLabels(innerWidth, innerHeight);
  grade.uniforms.uTime.value = t;
  composer.render();
});
