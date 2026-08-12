import * as THREE from 'three';

/**
 * Gradacao final: vinheta, leve realce de saturacao nos neons e um grao
 * discreto. Sem isso a imagem sai "limpa demais" -- o preto chapado do fundo
 * denuncia render sintetico e o olho nao tem pra onde ir.
 */
export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.8 },
    uSaturation: { value: 1.12 },
    uGrain: { value: 0.022 },
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uSaturation, uGrain;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);

      // saturacao: puxa os neons sem estourar o resto
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSaturation);

      // vinheta suave
      vec2 d = (vUv - 0.5) * vec2(1.0, 0.92);
      c.rgb *= 1.0 - uVignette * dot(d, d) * 0.85;

      // grao ancorado no tempo, mais visivel nas sombras
      float g = hash(vUv * 1024.0 + fract(uTime) * 91.7) - 0.5;
      c.rgb += g * uGrain * (1.0 - l);

      gl_FragColor = c;
    }
  `,
};
