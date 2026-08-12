import * as THREE from 'three';
import { BLOCK, CELL, GRID } from './layout';

/**
 * Chao: asfalto escuro + malha viaria emissiva alinhada as ruas do layout,
 * com fade radial pra cidade se dissolver no escuro na borda.
 */
export interface Ground {
  mesh: THREE.Mesh;
  /** ancora o fade na mancha urbana ocupada */
  setArea(cx: number, cz: number, r: number): void;
}

export function makeGround(): Ground {
  const size = GRID * CELL;
  const geo = new THREE.PlaneGeometry(size * 1.15, size * 1.15, 1, 1);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uCell: { value: CELL },
      uBlock: { value: BLOCK },
      uHalf: { value: (GRID - 1) / 2 },
      uCenter: { value: new THREE.Vector2() },
      uRadius: { value: size * 0.35 },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime, uCell, uBlock, uHalf, uRadius;
      uniform vec2 uCenter;
      varying vec3 vWorld;

      void main() {
        vec2 c = vWorld.xz / uCell + uHalf;
        vec2 m = mod(c, uBlock);
        float center = uBlock - 0.5;
        float sx = 1.0 - smoothstep(0.10, 0.46, abs(m.x - center));
        float sz = 1.0 - smoothstep(0.10, 0.46, abs(m.y - center));
        float street = max(sx, sz);

        // linha central mais fina e mais quente
        float lx = 1.0 - smoothstep(0.0, 0.07, abs(m.x - center));
        float lz = 1.0 - smoothstep(0.0, 0.07, abs(m.y - center));
        float lane = max(lx, lz);

        // ruas sao contexto, nao protagonista: brilho baixo pra nao competir
        // com as janelas dos predios no bloom
        vec3 asphalt = vec3(0.012, 0.018, 0.036);
        vec3 glow = vec3(0.05, 0.42, 0.78) * street * 0.13
                  + vec3(0.45, 0.22, 0.85) * lane * 0.16;

        float d = length(vWorld.xz - uCenter) / uRadius;
        float fade = 1.0 - smoothstep(0.75, 1.15, d);

        vec3 col = (asphalt + glow) * fade;
        gl_FragColor = vec4(col, fade);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.01;
  mesh.renderOrder = -1;

  return {
    mesh,
    setArea(cx: number, cz: number, r: number): void {
      mat.uniforms.uCenter.value.set(cx, cz);
      mat.uniforms.uRadius.value = r * 1.35 + 12;
    },
  };
}
