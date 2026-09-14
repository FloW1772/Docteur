import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Page } from '../../lib/types';

interface OrbitalNode {
  pageId: string;
  title: string;
  kind: Page['kind'];
  ringIndex: number;
  angle: number;
  group: THREE.Group;
  core: THREE.Mesh;
  halo: THREE.Mesh;
  aura: THREE.Mesh;
  glow: THREE.Mesh;
  indexRing:     THREE.Mesh;  // pulsing yellow ring — cortex indexing in progress
  highlightRing: THREE.Mesh;  // pulsing white ring — search source highlight
  orbitRadiusX: number;
  orbitRadiusY: number;
  orbitLift: number;
  orbitSpeed: number;
  orbitPhase: number;
  pulseSeed: number;
}

interface LinkVisual {
  startId: string;
  endId: string;
  tube: THREE.Mesh;
  dots: THREE.Mesh[];
  curve: THREE.CubicBezierCurve3;
  phase: number;
  speed: number;
  radius: number;
  material: THREE.ShaderMaterial;
}

interface ParticleSeed {
  base: THREE.Vector3;
  velocity: THREE.Vector3;
  phase: number;
}

interface ParticleLayer {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  seeds: ParticleSeed[];
  minRadius: number;
  maxRadius: number;
  drift: number;
  swirl: number;
  spin: THREE.Vector3;
}

interface ParticleLayerConfig {
  count: number;
  minRadius: number;
  maxRadius: number;
  size: number;
  opacity: number;
  color: THREE.ColorRepresentation;
  drift: number;
  swirl: number;
  spin: THREE.Vector3;
}

interface NodeVisualConfig {
  coreColor: number;
  coreEmissive: number;
  haloColor: number;
  haloEmissive: number;
  haloOpacity: number;
  auraColor: number;
  auraEmissive: number;
  auraOpacity: number;
  glowColor: number;
  glowEmissive: number;
  glowOpacity: number;
  scale: number;
  emissiveIntensity: number;
}

interface JetStream {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  direction: THREE.Vector3;
  count: number;
  phases: Float32Array;
  speeds: Float32Array;
  spreads: Float32Array;
}

interface FocusDot {
  mesh: THREE.Mesh;
  phase: number;
  speed: number;
}

interface FocusLine {
  line: THREE.Line;
  geometry: THREE.BufferGeometry;
  posAttr: THREE.BufferAttribute;
  material: THREE.LineBasicMaterial;
  dots: FocusDot[];
  nodeId: string;
}

interface Props {
  pages: Page[];
  selectedPageId?: string | null;
  compact?: boolean;
  className?: string;
  onNodeSelect?: (pageId: string) => void;
  onCentralActivate?: () => void;
  onHoverChange?: (payload: { title: string; x: number; y: number } | null) => void;
  bloomEnabled?: boolean;
  onPerformance?: (payload: { fps: number; bloomActive: boolean }) => void;
  indexingIds?: Set<string>;    // IDs currently being indexed by the cortex server
  highlightedIds?: Set<string>; // IDs of search result sources to highlight
  gestureInputRef?: React.MutableRefObject<((rotDx: number, rotDy: number, zoomDelta: number) => void) | null>;
}

// ── Visual control panel ──────────────────────────────────────────────────────

const VISUAL_SETTINGS_KEY = 'docteur.visualSettings';

interface VisualSettings {
  flowParticles: boolean;
  bgAnimations:  boolean;
  showNodes:     boolean;
  showLinks:     boolean;
  showLabels:    boolean;
  kindFilter:    string[];   // empty = show all kinds
  isolateSelected: boolean;
  focusChannelId:  string | null;
  maxNodes:      number;
}

const DEFAULT_VISUAL_SETTINGS: VisualSettings = {
  flowParticles:   true,
  bgAnimations:    true,
  showNodes:       true,
  showLinks:       true,
  showLabels:      true,
  kindFilter:      [],
  isolateSelected: false,
  focusChannelId:  null,
  maxNodes:        500,
};

function loadVisualSettings(): VisualSettings {
  try {
    const raw = localStorage.getItem(VISUAL_SETTINGS_KEY);
    if (!raw) return DEFAULT_VISUAL_SETTINGS;
    return { ...DEFAULT_VISUAL_SETTINGS, ...JSON.parse(raw) as Partial<VisualSettings> };
  } catch {
    return DEFAULT_VISUAL_SETTINGS;
  }
}

const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0.30 },
    offset: { value: 1.15 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform float offset;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      vec2 centered = (vUv - 0.5) * offset;
      float vignette = smoothstep(0.95, 0.25, dot(centered, centered));
      color.rgb *= mix(1.0 - strength, 1.0, vignette);
      gl_FragColor = color;
    }
  `,
};

const ChromaticAberrationShader = {
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0.0016 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float strength;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - 0.5;
      float dist2 = dot(dir, dir);
      vec2 offset = dir * strength * dist2 * 4.0;
      float r = texture2D(tDiffuse, vUv + offset).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - offset).b;
      float a = texture2D(tDiffuse, vUv).a;
      gl_FragColor = vec4(r, g, b, a);
    }
  `,
};

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.codePointAt(i) ?? 0;
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeTextSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 24px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(160, 180, 210, 0.70)';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  return new THREE.Sprite(material);
}

function createRadialTexture(inner: string, outer: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
    gradient.addColorStop(0, inner);
    gradient.addColorStop(0.42, inner);
    gradient.addColorStop(1, outer);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) {
    material.forEach(item => disposeMaterial(item));
    return;
  }
  const m = material as THREE.Material & { map?: THREE.Texture; alphaMap?: THREE.Texture; emissiveMap?: THREE.Texture; normalMap?: THREE.Texture; roughnessMap?: THREE.Texture; metalnessMap?: THREE.Texture; clearcoatNormalMap?: THREE.Texture; sheenColorMap?: THREE.Texture; transmissionMap?: THREE.Texture };
  m.map?.dispose();
  m.alphaMap?.dispose();
  m.emissiveMap?.dispose();
  m.normalMap?.dispose();
  m.roughnessMap?.dispose();
  m.metalnessMap?.dispose();
  m.clearcoatNormalMap?.dispose();
  m.sheenColorMap?.dispose();
  m.transmissionMap?.dispose();
  material.dispose();
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.Line) {
      child.geometry.dispose();
      disposeMaterial(child.material as THREE.Material | THREE.Material[]);
    }
  });
}

function createEnergyMaterial(color: THREE.ColorRepresentation, opacity: number, pulseStrength = 0.18): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: opacity },
      uColor: { value: new THREE.Color(color) },
      uPulseStrength: { value: pulseStrength },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uOpacity;
      uniform vec3 uColor;
      uniform float uPulseStrength;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        float centerFade = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.82, vUv.y);
        float edgeGlow = 0.3 + 0.7 * pow(1.0 - abs(vUv.x - 0.5) * 2.0, 2.0);
        float pulse = 0.8 + sin(uTime * 2.0 + vPosition.x * 7.0 + vPosition.y * 4.0) * uPulseStrength;
        vec3 color = uColor * (0.65 + edgeGlow * 0.55 + pulse * 0.18);
        float alpha = uOpacity * centerFade * pulse * (0.45 + edgeGlow * 0.55);
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
}

function createCorePlasmaMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uHover: { value: 0 },
      uWake: { value: 0 },
    },
    vertexShader: `
      uniform float uTime;
      uniform float uHover;
      uniform float uWake;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying vec2 vUv;
      float hash(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.17, 0.31, 0.43));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float noise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash(i + vec3(0.0, 0.0, 0.0));
        float n100 = hash(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash(i + vec3(1.0, 1.0, 1.0));
        float n00 = mix(n000, n100, f.x);
        float n10 = mix(n010, n110, f.x);
        float n01 = mix(n001, n101, f.x);
        float n11 = mix(n011, n111, f.x);
        float n0 = mix(n00, n10, f.y);
        float n1 = mix(n01, n11, f.y);
        return mix(n0, n1, f.z);
      }
      float fbm(vec3 p) {
        float value = 0.0;
        float amplitude = 0.55;
        for (int i = 0; i < 4; i++) {
          value += amplitude * noise(p);
          p *= 2.02;
          amplitude *= 0.52;
        }
        return value;
      }
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vPosition = position;
        vUv = uv;
        float n = fbm(position * 2.4 + vec3(uTime * 0.45, uTime * 0.28, uTime * 0.18));
        float ripple = sin(uTime * 2.1 + position.y * 7.0 + n * 5.0) * 0.05;
        float wake = sin(uTime * 3.2 + uWake * 6.2831) * 0.025;
        vec3 displaced = position + normal * (n * 0.06 + ripple + wake + uHover * 0.015);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uHover;
      uniform float uWake;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying vec2 vUv;
      void main() {
        vec3 n = normalize(vNormal);
        float facing  = max(dot(n, vec3(0.0, 0.0, 1.0)), 0.0);
        float fresnel = pow(1.0 - facing, 2.6);

        float swirl  = 0.5 + 0.5 * sin(uTime * 2.4 + vPosition.x * 6.0 - vPosition.y * 5.5 + vPosition.z * 4.2);
        float pulse  = 0.5 + 0.5 * sin(uTime * 1.9 + vUv.x * 7.0 + vUv.y * 5.0);
        float detail = 0.5 + 0.5 * sin(uTime * 5.5 + vPosition.x * 14.0 + vPosition.z * 11.0);
        float hotspot = pow(facing, 1.6) * 0.55;

        float energy = clamp(0.05 + fresnel * 0.50 + swirl * 0.12 + pulse * 0.07 + hotspot
                             + uHover * 0.15 + uWake * 0.22, 0.0, 1.0);

        // Cinematic dark palette — no electric blue, no neon
        vec3 deepVoid  = vec3(0.04, 0.04, 0.08);   // near-black deep space
        vec3 coldGrey  = vec3(0.12, 0.145, 0.21);  // grey-blue shadow
        vec3 midGrey   = vec3(0.22, 0.19, 0.30);   // grey-violet mid
        vec3 warmGrey  = vec3(0.38, 0.32, 0.42);   // muted warm violet
        vec3 hotCore   = vec3(0.95, 0.92, 0.88);   // off-white, barely yellow

        vec3 color = mix(deepVoid, coldGrey,  clamp(energy * 1.6,          0.0, 1.0));
        color      = mix(color,   midGrey,    clamp((energy - 0.30) * 2.5, 0.0, 1.0));
        color      = mix(color,   warmGrey,   clamp((energy - 0.55) * 3.0, 0.0, 1.0));
        color      = mix(color,   hotCore,    clamp((energy - 0.78) * 5.0 + hotspot * 0.45, 0.0, 1.0));

        // Very subtle warm flicker at extreme energy peaks
        vec3 warmFlicker = vec3(0.98, 0.78, 0.55);
        color = mix(color, warmFlicker, clamp((detail - 0.88) * 2.5 * hotspot * 0.3, 0.0, 0.08));

        // Subtle violet corona at rim
        vec3 corona = vec3(0.15, 0.08, 0.25);
        color = mix(color, corona, fresnel * 0.18);

        float alpha = 0.48 + hotspot * 0.35 + fresnel * 0.08;
        gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
      }
    `,
  });
}

function createJetStreamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute float aPhase;
      varying float vPhase;
      void main() {
        vPhase = aPhase;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        float size = 3.8 * (1.0 - aPhase * 0.55);
        gl_PointSize = max(1.0, size / (-mvPos.z * 0.16));
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying float vPhase;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        float circle = smoothstep(0.5, 0.05, d);
        float alpha = circle * pow(1.0 - vPhase, 1.8) * 0.55;
        if (alpha < 0.004) discard;
        // warm white-yellow fading to cool dim
        vec3 color = mix(vec3(1.0, 0.96, 0.82), vec3(0.65, 0.75, 0.90), vPhase * 0.6);
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
}

class OrbitalBrain {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private composer!: EffectComposer;
  private renderPass!: RenderPass;
  private bloomPass!: UnrealBloomPass;
  private vignettePass!: ShaderPass;
  private caPass!: ShaderPass;
  private readonly root: THREE.Group;
  private readonly atmosphereGroup: THREE.Group;
  private readonly coreGroup: THREE.Group;
  private readonly reactorGroup: THREE.Group;
  private readonly outerRingGroup: THREE.Group;
  private readonly nodeGroup: THREE.Group;
  private readonly linkGroup: THREE.Group;
  private readonly jetGroup: THREE.Group;
  private readonly labelGroup: THREE.Group;
  private centralHitSphere?: THREE.Mesh;
  private centralGlass?: THREE.Mesh;
  private centralPlasma?: THREE.Mesh;
  private centralHalo?: THREE.Mesh;
  private centralAura?: THREE.Mesh;
  private plasmaLayers: ParticleLayer[] = [];
  private atmosphereLayers: ParticleLayer[] = [];
  private atmosphereComets: { mesh: THREE.Mesh; velocity: THREE.Vector3; trail: THREE.Line; points: THREE.Vector3[] }[] = [];
  private ringMeshes: THREE.Mesh[] = [];
  private coilMeshes: THREE.Mesh[] = [];
  private jetStreams: JetStream[] = [];
  private labels: THREE.Sprite[] = [];
  private readonly nodes = new Map<string, OrbitalNode>();
  private links: LinkVisual[] = [];
  private focusLine?: FocusLine;
  private readonly pointer = new THREE.Vector2();
  private readonly raycaster = new THREE.Raycaster();
  private hoveredNodeId: string | null = null;
  private hoveredCentral = false;
  private wakePulse = 0;
  private dragActive = false;
  private readonly dragStart = new THREE.Vector2();
  private readonly dragTargetRotation = new THREE.Vector2(0, 0);
  private readonly dragRotationStart = new THREE.Vector2(0, 0);
  private zoomTarget = 5.5;
  private animId = 0;
  private lastFrame = 0;
  private orbitPhase = 0;
  private fpsEstimate = 60;
  private frameCount = 0;
  private indexingIds   = new Set<string>();
  private highlightedIds = new Set<string>();
  private readonly onNodeSelect?: (pageId: string) => void;
  private readonly onCentralActivate?: () => void;
  private readonly onHoverChange?: (payload: { title: string; x: number; y: number } | null) => void;
  private readonly onPerformance?: (payload: { fps: number; bloomActive: boolean }) => void;
  private selectedPageId: string | null = null;
  private readonly corePlasmaMaterial: THREE.ShaderMaterial;
  private readonly radialTexture: THREE.CanvasTexture;
  private readonly compact: boolean;
  private readonly bloomEnabled: boolean;
  private vs: VisualSettings = DEFAULT_VISUAL_SETTINGS;

  constructor(
    canvas: HTMLCanvasElement,
    compact: boolean,
    onNodeSelect?: (pageId: string) => void,
    onCentralActivate?: () => void,
    onHoverChange?: (payload: { title: string; x: number; y: number } | null) => void,
    onPerformance?: (payload: { fps: number; bloomActive: boolean }) => void,
    bloomEnabled = true,
  ) {
    this.onNodeSelect = onNodeSelect;
    this.onCentralActivate = onCentralActivate;
    this.onHoverChange = onHoverChange;
    this.onPerformance = onPerformance;
    this.compact = compact;
    this.bloomEnabled = bloomEnabled;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08080e);
    this.scene.fog = new THREE.FogExp2(0x08080e, 0.055);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(0, 1.5, compact ? 5 : 5.5);

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1, false);
    this.renderer.setClearColor(0x08080e, 1);
    this.renderer.sortObjects = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    (this.renderer as THREE.WebGLRenderer & { physicallyCorrectLights?: boolean }).physicallyCorrectLights = true;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    this.scene.environment = pmrem.fromScene(new RoomEnvironment()).texture;
    this.scene.environmentIntensity = 0.22;
    pmrem.dispose();

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.atmosphereGroup = new THREE.Group();
    this.scene.add(this.atmosphereGroup);

    this.coreGroup = new THREE.Group();
    this.root.add(this.coreGroup);

    this.reactorGroup = new THREE.Group();
    this.root.add(this.reactorGroup);

    this.outerRingGroup = new THREE.Group();
    this.root.add(this.outerRingGroup);

    this.nodeGroup = new THREE.Group();
    this.root.add(this.nodeGroup);

    this.linkGroup = new THREE.Group();
    this.root.add(this.linkGroup);

    this.jetGroup = new THREE.Group();
    this.root.add(this.jetGroup);

    this.labelGroup = new THREE.Group();
    this.root.add(this.labelGroup);

    this.radialTexture = createRadialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
    this.corePlasmaMaterial = createCorePlasmaMaterial();

    this.buildLights();
    this.buildCore();
    this.buildReactorRing();
    this.buildOuterRing();
    this.buildJetStreams();
    this.buildAtmosphere();
    this.buildLabels();
    this.buildComposer();
    this.handleResize();
    this.animate();
  }

  private buildLights(): void {
    // Minimal ambient — space is dark
    const ambient = new THREE.AmbientLight(0x0a0a1a, 0.15);
    this.scene.add(ambient);

    // Core point light — warm star, physically correct inverse-square falloff
    const coreLight = new THREE.PointLight(0xffd9a0, 4.5, 6, 2);
    coreLight.position.set(0, 0, 0);
    this.coreGroup.add(coreLight);

    // Key directional — cool blue-grey, upper front-right
    const key = new THREE.DirectionalLight(0x5070a0, 0.3);
    key.position.set(5, 3, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.00015;
    this.scene.add(key);

    // Rim — warm orange, opposite of key, separates objects from bg
    const rim = new THREE.DirectionalLight(0xffaa66, 0.2);
    rim.position.set(-5, -3, -5);
    this.scene.add(rim);
  }

  private buildCore(): void {
    // Outer glass sphere — deep night blue, semi-transparent
    const glassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x1a3a5c,
      transmission: 0.6,
      thickness: 0.8,
      roughness: 0.3,
      metalness: 0,
      ior: 1.4,
      iridescence: 0.3,
      iridescenceIOR: 1.3,
      clearcoat: 0.5,
      clearcoatRoughness: 0.1,
      transparent: true,
      opacity: 1,
      emissive: 0x2a5080,
      emissiveIntensity: 0.4,
      depthWrite: false,
    });

    this.centralGlass = new THREE.Mesh(new THREE.SphereGeometry(0.7, 32, 32), glassMaterial);
    this.centralGlass.castShadow = true;
    this.centralGlass.receiveShadow = true;
    this.coreGroup.add(this.centralGlass);

    // Inner plasma sphere
    this.centralPlasma = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 32), this.corePlasmaMaterial);
    this.coreGroup.add(this.centralPlasma);

    // Narrow inner aura — very subtle depth layer
    this.centralAura = new THREE.Mesh(
      new THREE.SphereGeometry(0.88, 20, 20),
      new THREE.MeshPhysicalMaterial({
        color: 0x2a4060,
        emissive: 0x1a3050,
        emissiveIntensity: 0.1,
        transparent: true,
        opacity: 0.03,
        roughness: 0.6,
        metalness: 0,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.coreGroup.add(this.centralAura);

    // Wide corona — barely perceptible stellar corona
    this.centralHalo = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 20, 20),
      new THREE.MeshPhysicalMaterial({
        color: 0xfff0e0,
        emissive: 0xfff0e0,
        emissiveIntensity: 0.015,
        transparent: true,
        opacity: 0.028,
        roughness: 0.5,
        metalness: 0,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.coreGroup.add(this.centralHalo);

    this.centralHitSphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.95, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 })
    );
    this.centralHitSphere.userData.role = 'central';
    this.coreGroup.add(this.centralHitSphere);

    // Inner plasma particle layers — dark, muted
    this.plasmaLayers = [
      this.buildParticleLayer({ count: 55, minRadius: 0.12, maxRadius: 0.24, size: 0.016, opacity: 0.28, color: 0x0f1a2e, drift: 0.0008, swirl: 0.0007, spin: new THREE.Vector3(0.002, 0.001, 0.001) }),
      this.buildParticleLayer({ count: 45, minRadius: 0.18, maxRadius: 0.36, size: 0.020, opacity: 0.24, color: 0x253040, drift: 0.001, swirl: 0.0009, spin: new THREE.Vector3(-0.001, 0.0013, 0.001) }),
      this.buildParticleLayer({ count: 35, minRadius: 0.26, maxRadius: 0.48, size: 0.026, opacity: 0.18, color: 0xe8e0d4, drift: 0.0012, swirl: 0.0011, spin: new THREE.Vector3(0.001, -0.0007, 0.0014) }),
    ];

    this.plasmaLayers.forEach((layer, index) => {
      layer.points.position.z = (index - 1) * 0.012;
      this.coreGroup.add(layer.points);
    });
  }

  private buildReactorRing(): void {
    // Rings removed — appear as distracting arcs in the composition
  }

  private buildOuterRing(): void {
    // Outer rings removed — too visually dominant as large arcs at steep tilt
  }

  private buildJetStreams(): void {
    const directions = [
      new THREE.Vector3(1, 0.08, 0.15),
      new THREE.Vector3(0.45, 0.82, -0.1),
      new THREE.Vector3(-0.2, 0.88, 0.34),
      new THREE.Vector3(-0.82, 0.2, -0.18),
      new THREE.Vector3(-0.45, -0.78, 0.22),
    ];

    directions.forEach((dir, dirIndex) => {
      const direction = dir.clone().normalize();
      const count = 120;
      const phases = new Float32Array(count);
      const speeds = new Float32Array(count);
      const spreads = new Float32Array(count);
      const posBuffer = new Float32Array(count * 3);
      const rng = seededRandom(hashString(`jet-${dirIndex}`));
      const JET_LENGTH = 2.2;
      const SPAWN_DIST = 0.85;

      for (let i = 0; i < count; i++) {
        phases[i] = rng();
        speeds[i] = 0.08 + rng() * 0.12;
        spreads[i] = (rng() - 0.5);
        const dist = SPAWN_DIST + phases[i] * JET_LENGTH;
        const noise = 0.12;
        posBuffer[i * 3]     = direction.x * dist + spreads[i] * noise * Math.sin(phases[i] * 13.0 + i * 0.43);
        posBuffer[i * 3 + 1] = direction.y * dist + spreads[i] * noise * Math.cos(phases[i] * 11.0 + i * 0.67);
        posBuffer[i * 3 + 2] = direction.z * dist + spreads[i] * noise * Math.sin(phases[i] * 9.0 + i * 0.89);
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(posBuffer, 3));
      geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

      const material = createJetStreamMaterial();
      const points = new THREE.Points(geometry, material);
      this.jetGroup.add(points);

      this.jetStreams.push({ points, geometry, material, direction, count, phases, speeds, spreads });
    });
  }

  private buildAtmosphere(): void {
    this.atmosphereLayers = [
      this.buildParticleLayer({ count: this.compact ? 65 : 90, minRadius: 4, maxRadius: 9, size: 0.020, opacity: 0.10, color: 0xffffff, drift: 0.00018, swirl: 0.6, spin: new THREE.Vector3(0.002, 0.0008, 0.001) }),
      this.buildParticleLayer({ count: this.compact ? 35 : 50, minRadius: 3.2, maxRadius: 7.2, size: 0.032, opacity: 0.14, color: 0xbfdcff, drift: 0.00026, swirl: 0.8, spin: new THREE.Vector3(-0.001, 0.001, 0.0013) }),
      this.buildParticleLayer({ count: this.compact ? 14 : 22, minRadius: 2.2, maxRadius: 5.2, size: 0.050, opacity: 0.16, color: 0x88c6ff, drift: 0.00035, swirl: 1, spin: new THREE.Vector3(0.001, 0.0012, -0.0009) }),
    ];

    this.atmosphereLayers.forEach(layer => {
      this.atmosphereGroup.add(layer.points);
    });

    const cometCount = this.compact ? 2 : 3;
    for (let i = 0; i < cometCount; i += 1) {
      const trailPoints = Array.from({ length: 10 }, () => new THREE.Vector3());
      const trailGeometry = new THREE.BufferGeometry().setFromPoints(trailPoints);
      const trailMaterial = new THREE.LineBasicMaterial({
        color: 0x9ab8d8,
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const trail = new THREE.Line(trailGeometry, trailMaterial);
      this.atmosphereGroup.add(trail);

      const comet = new THREE.Mesh(
        new THREE.SphereGeometry(0.018, 8, 8),
        new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          emissive: 0x9ecbff,
          emissiveIntensity: 1.0,
          transparent: true,
          opacity: 0.70,
          metalness: 0,
          roughness: 0.2,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      this.atmosphereGroup.add(comet);
      this.atmosphereComets.push({
        mesh: comet,
        velocity: new THREE.Vector3((i % 2 === 0 ? 1 : -1) * 0.012, 0.007 + i * 0.002, 0.005 - i * 0.001),
        trail,
        points: trailPoints,
      });
    }
  }

  private buildLabels(): void {
    const positions = [
      new THREE.Vector3(2.95, 0.25, 0.1),
      new THREE.Vector3(-2.1, 1.62, 0.15),
      new THREE.Vector3(-2.85, -1.42, -0.05),
      new THREE.Vector3(1.95, -1.82, 0.2),
    ];
    ['SYS-01', 'SYS-02', 'SYS-03', 'SYS-04'].forEach((label, index) => {
      const sprite = makeTextSprite(label);
      sprite.position.copy(positions[index]);
      sprite.scale.set(0.34, 0.09, 1);
      this.labelGroup.add(sprite);
      this.labels.push(sprite);
    });
  }

  private buildComposer(): void {
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // Bloom — much more restrained than before, only hits extreme highlights
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.25, 0.4, 0.92);
    this.bloomPass.enabled = this.bloomEnabled;
    this.composer.addPass(this.bloomPass);

    // Vignette — slightly more pronounced for cinematic look
    this.vignettePass = new ShaderPass(VignetteShader);
    this.vignettePass.uniforms.strength.value = 0.30;
    this.vignettePass.uniforms.offset.value = 1.12;
    this.composer.addPass(this.vignettePass);

    // Chromatic aberration — very subtle, edge-only, cinematic character
    this.caPass = new ShaderPass(ChromaticAberrationShader);
    this.caPass.uniforms.strength.value = 0.0016;
    this.composer.addPass(this.caPass);
  }

  private buildParticleLayer(config: ParticleLayerConfig): ParticleLayer {
    const { count, minRadius, maxRadius, size, opacity, color, drift, swirl, spin } = config;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const rng = seededRandom(hashString(`${count}-${minRadius}-${maxRadius}-${size}-${opacity}`));
    const seeds: ParticleSeed[] = [];
    for (let i = 0; i < count; i += 1) {
      const shell = minRadius + (maxRadius - minRadius) * Math.cbrt(rng());
      const theta = rng() * Math.PI * 2;
      const phi = Math.acos(2 * rng() - 1);
      const x = shell * Math.sin(phi) * Math.cos(theta);
      const y = shell * Math.cos(phi);
      const z = shell * Math.sin(phi) * Math.sin(theta);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      seeds.push({
        base: new THREE.Vector3(x, y, z),
        velocity: new THREE.Vector3((rng() - 0.5) * drift, (rng() - 0.5) * drift, (rng() - 0.5) * drift),
        phase: rng() * Math.PI * 2,
      });
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      size,
      color,
      map: this.radialTexture,
      alphaMap: this.radialTexture,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geometry, material);
    return { points, geometry, material, seeds, minRadius, maxRadius, drift, swirl, spin };
  }

  private getNodeOrbit(hash: number, ringIndex: number): { angle: number; orbitRadiusX: number; orbitRadiusY: number; orbitLift: number; orbitSpeed: number; orbitPhase: number } {
    const rng = seededRandom(hash);
    const baseRadius = [1.15, 1.78, 2.28][ringIndex];
    const angle = ((hash / 4294967295) * Math.PI * 2 + ringIndex * 0.42) % (Math.PI * 2);
    return {
      angle,
      orbitRadiusX: baseRadius * (0.88 + rng() * 0.22),
      orbitRadiusY: baseRadius * (0.72 + rng() * 0.18),
      orbitLift: (rng() - 0.5) * 0.42,
      orbitSpeed: 0.18 + rng() * 0.14,
      orbitPhase: rng() * Math.PI * 2,
    };
  }

  private getNodeVisualConfig(kind: Page['kind'], isActive: boolean, isHovered: boolean): NodeVisualConfig {
    if (kind === 'channel') {
      if (isActive) {
        return {
          coreColor: 0xff8b3d,
          coreEmissive: 0xff7a1f,
          haloColor: 0xff9a52,
          haloEmissive: 0xff7a1f,
          haloOpacity: 0.24,
          auraColor: 0xffb06e,
          auraEmissive: 0xff8b3d,
          auraOpacity: 0.18,
          glowColor: 0xffc08d,
          glowEmissive: 0xff8b3d,
          glowOpacity: 0.42,
          scale: 1.48,
          emissiveIntensity: 1.55,
        };
      }

      if (isHovered) {
        return {
          coreColor: 0xff8b3d,
          coreEmissive: 0xff7a1f,
          haloColor: 0xffa96b,
          haloEmissive: 0xff8b3d,
          haloOpacity: 0.18,
          auraColor: 0xffbf8f,
          auraEmissive: 0xff9a52,
          auraOpacity: 0.12,
          glowColor: 0xffcfb0,
          glowEmissive: 0xffa96b,
          glowOpacity: 0.34,
          scale: 1.24,
          emissiveIntensity: 1.05,
        };
      }

      return {
        coreColor: 0xff8b3d,
        coreEmissive: 0xff6f12,
        haloColor: 0xff9f5d,
        haloEmissive: 0xff8b3d,
        haloOpacity: 0.12,
        auraColor: 0xffb06e,
        auraEmissive: 0xff8b3d,
        auraOpacity: 0.10,
        glowColor: 0xffc08d,
        glowEmissive: 0xff9a52,
        glowOpacity: 0.26,
        scale: 1.18,
        emissiveIntensity: 0.95,
      };
    }

    if (isActive) {
      return {
        coreColor: 0xf8e8a0,
        coreEmissive: 0xf0d090,
        haloColor: 0xf8e8a0,
        haloEmissive: 0xf0d090,
        haloOpacity: 0.20,
        auraColor: 0xffe0a0,
        auraEmissive: 0xffd080,
        auraOpacity: 0.14,
        glowColor: 0xffe880,
        glowEmissive: 0xffd080,
        glowOpacity: 0.35,
        scale: 1.4,
        emissiveIntensity: 1.2,
      };
    }

    if (isHovered) {
      return {
        coreColor: 0xc8d4e8,
        coreEmissive: 0xa0b8d8,
        haloColor: 0xb8cce8,
        haloEmissive: 0x9ab2d0,
        haloOpacity: 0.14,
        auraColor: 0x90a8c8,
        auraEmissive: 0x7090b8,
        auraOpacity: 0.10,
        glowColor: 0xb0c8e8,
        glowEmissive: 0x80a8d0,
        glowOpacity: 0.26,
        scale: 1.2,
        emissiveIntensity: 0.85,
      };
    }

    return {
      coreColor: 0xaabbcc,
      coreEmissive: 0x80a0c0,
      haloColor: 0xaabbcc,
      haloEmissive: 0x80a0c0,
      haloOpacity: 0.09,
      auraColor: 0x8090a8,
      auraEmissive: 0x4060a0,
      auraOpacity: 0.07,
      glowColor: 0x90b0d0,
      glowEmissive: 0x6090c0,
      glowOpacity: 0.18,
      scale: 1,
      emissiveIntensity: 0.6,
    };
  }

  private createNodeVisual(page: Page, selectedPageId: string | null): OrbitalNode {
    const hash = hashString(page.id);
    const ringIndex = hash % 3;
    const orbit = this.getNodeOrbit(hash, ringIndex);
    const isActive = page.id === selectedPageId;
    const group = new THREE.Group();
    group.userData.pageId = page.id;
    group.userData.title = page.title || 'Sans titre';
    group.position.set(Math.cos(orbit.angle) * orbit.orbitRadiusX, orbit.orbitLift, Math.sin(orbit.angle) * orbit.orbitRadiusY);

    const visual = this.getNodeVisualConfig(page.kind, isActive, false);
    // Metallic node — not glass
    const coreMaterial = new THREE.MeshPhysicalMaterial({
      color: visual.coreColor,
      metalness: 0.5,
      roughness: 0.3,
      emissive: visual.coreEmissive,
      emissiveIntensity: visual.emissiveIntensity,
      envMapIntensity: 0.8,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    const haloMaterial = new THREE.MeshPhysicalMaterial({
      color: visual.haloColor,
      emissive: visual.haloEmissive,
      emissiveIntensity: visual.emissiveIntensity,
      transparent: true,
      opacity: visual.haloOpacity,
      metalness: 0,
      roughness: 0.45,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const auraMaterial = new THREE.MeshPhysicalMaterial({
      color: visual.auraColor,
      emissive: visual.auraEmissive,
      emissiveIntensity: visual.emissiveIntensity,
      transparent: true,
      opacity: visual.auraOpacity,
      metalness: 0,
      roughness: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const glowMaterial = new THREE.MeshPhysicalMaterial({
      color: visual.glowColor,
      emissive: visual.glowEmissive,
      emissiveIntensity: visual.emissiveIntensity * 1.3,
      transparent: true,
      opacity: visual.glowOpacity,
      metalness: 0,
      roughness: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const core = new THREE.Mesh(new THREE.SphereGeometry(0.060, 20, 20), coreMaterial);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.14, 18, 18), haloMaterial);
    const aura = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.010, 12, 32), auraMaterial);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.040, 16, 16), glowMaterial);
    aura.rotation.x = Math.PI * 0.5;
    core.castShadow = true;
    core.receiveShadow = true;

    // Indexing ring — pulsing yellow when cortex is embedding this node
    const indexRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.20, 0.007, 8, 32),
      new THREE.MeshBasicMaterial({
        color:       0xffcc44,
        transparent: true,
        opacity:     0,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
      }),
    );
    indexRing.rotation.x = Math.PI * 0.5;
    indexRing.visible = false;

    // Highlight ring — bright white/cyan pulse when node is a search result source
    const highlightRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.26, 0.009, 8, 32),
      new THREE.MeshBasicMaterial({
        color:       0xddeeff,
        transparent: true,
        opacity:     0,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
      }),
    );
    highlightRing.rotation.x = Math.PI * 0.5;
    highlightRing.visible = false;

    group.add(core, halo, aura, glow, indexRing, highlightRing);

    return {
      pageId: page.id,
      title: page.title,
      kind: page.kind,
      ringIndex,
      angle: orbit.angle,
      group,
      core,
      halo,
      aura,
      glow,
      indexRing,
      highlightRing,
      orbitRadiusX: orbit.orbitRadiusX,
      orbitRadiusY: orbit.orbitRadiusY,
      orbitLift: orbit.orbitLift,
      orbitSpeed: orbit.orbitSpeed,
      orbitPhase: orbit.orbitPhase,
      pulseSeed: (hash % 1000) / 1000,
    };
  }

  private clearDynamic(): void {
    this.links.forEach(link => this.disposeLink(link));
    this.links = [];
    this.disposeFocusLine();

    this.nodes.forEach(node => {
      this.nodeGroup.remove(node.group);
      disposeObject(node.group);
    });
    this.nodes.clear();
  }

  setSelectedPageId(id: string | null): void {
    this.selectedPageId = id;
    this.syncNodeStates();
    this.applyVisualSettings();
  }

  private addSynapseLinks(pages: Page[]): void {
    const seen = new Set<string>();
    for (const page of pages) {
      for (const targetId of (page.links ?? [])) {
        const key = [page.id, targetId].sort().join(':');
        if (seen.has(key)) continue;
        seen.add(key);
        const start = this.nodes.get(page.id);
        const end   = this.nodes.get(targetId);
        if (!start || !end) continue;
        this.addLink(start, end, true);
      }
    }
  }

  private applyNodeVisualState(node: OrbitalNode, isActive: boolean, isHovered: boolean): void {
    const visual = this.getNodeVisualConfig(node.kind, isActive, isHovered);
    node.group.scale.setScalar(visual.scale);
    const coreMaterial = node.core.material as THREE.MeshPhysicalMaterial;
    const haloMaterial = node.halo.material as THREE.MeshPhysicalMaterial;
    const auraMaterial = node.aura.material as THREE.MeshPhysicalMaterial;
    const glowMaterial = node.glow.material as THREE.MeshPhysicalMaterial;

    coreMaterial.color.setHex(visual.coreColor);
    coreMaterial.emissive.setHex(visual.coreEmissive);
    coreMaterial.emissiveIntensity = visual.emissiveIntensity;
    haloMaterial.color.setHex(visual.haloColor);
    haloMaterial.emissive.setHex(visual.haloEmissive);
    haloMaterial.opacity = visual.haloOpacity;
    auraMaterial.color.setHex(visual.auraColor);
    auraMaterial.emissive.setHex(visual.auraEmissive);
    auraMaterial.opacity = visual.auraOpacity;
    glowMaterial.color.setHex(visual.glowColor);
    glowMaterial.emissive.setHex(visual.glowEmissive);
    glowMaterial.opacity = visual.glowOpacity;
  }

  private disposeLink(link: LinkVisual): void {
    this.linkGroup.remove(link.tube);
    link.dots.forEach(dot => {
      this.linkGroup.remove(dot);
      disposeObject(dot);
    });
    link.tube.geometry.dispose();
    link.material.dispose();
  }

  setPages(pages: Page[], selectedPageId: string | null): void {
    this.selectedPageId = selectedPageId;
    this.clearDynamic();

    // Limit displayed nodes to vs.maxNodes most recently updated
    const maxN = this.vs.maxNodes ?? 500;
    let displayed: Page[];
    if (pages.length > maxN) {
      const byRecency = [...pages].sort((a, b) => b.updatedAt - a.updatedAt);
      const top = byRecency.slice(0, maxN);
      // Always include the selected node even if outside top-N
      if (selectedPageId && !top.some(p => p.id === selectedPageId)) {
        const sel = pages.find(p => p.id === selectedPageId);
        if (sel) { top.pop(); top.push(sel); }
      }
      displayed = top;
    } else {
      displayed = pages;
    }

    const sorted = [...displayed].sort((a, b) => a.createdAt - b.createdAt);
    sorted.forEach(page => {
      const node = this.createNodeVisual(page, selectedPageId);
      this.nodeGroup.add(node.group);
      this.nodes.set(page.id, node);
    });

    this.addSynapseLinks(displayed);
    this.syncNodeStates();
    this.applyVisualSettings();
  }

  private addLink(start: OrbitalNode, end: OrbitalNode, isSynapse = false): void {
    // Use root-local positions (node.group is a direct child of nodeGroup/root — no extra transform)
    const startWorld = start.group.position.clone();
    const endWorld = end.group.position.clone();
    const control1 = startWorld.clone().lerp(endWorld, 0.32).add(new THREE.Vector3(0, 0.42, 0.22));
    const control2 = startWorld.clone().lerp(endWorld, 0.68).add(new THREE.Vector3(0, -0.28, -0.14));
    const curve = new THREE.CubicBezierCurve3(startWorld, control1, control2, endWorld);
    const isChannelLink = start.kind === 'channel' || end.kind === 'channel';
    const radius = (isChannelLink ? 0.022 : 0.018) + Math.max(start.ringIndex, end.ringIndex) * 0.003;
    const geometry = new THREE.TubeGeometry(curve, 14, radius, 6, false);
    // Synapses channel -> enfant: cyan plus lumineux; liens ordinaires: gris-bleu discret
    const material = createEnergyMaterial(isChannelLink ? 0x5ee7ff : (isSynapse ? 0x5ee7ff : 0x7090b8), isChannelLink ? 0.42 : (isSynapse ? 0.28 : 0.18), isChannelLink ? 0.18 : 0.12);
    const tube = new THREE.Mesh(geometry, material);
    this.linkGroup.add(tube);

    const dots: THREE.Mesh[] = [];
    const dotCount = isChannelLink ? 3 : 3 + ((start.ringIndex + end.ringIndex) % 3);
    for (let i = 0; i < dotCount; i += 1) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(radius * 0.55, 8, 8),
        new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          emissive: isChannelLink ? 0x5ee7ff : 0x9ab8d8,
          emissiveIntensity: isChannelLink ? 1.6 : 1.2,
          transparent: true,
          opacity: isChannelLink ? 0.96 : 0.88,
          metalness: 0,
          roughness: 0.2,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      this.linkGroup.add(dot);
      dots.push(dot);
    }

    this.links.push({ startId: start.pageId, endId: end.pageId, tube, dots, curve, phase: Math.random(), speed: 0.004 + Math.random() * 0.004, radius, material });
  }

  private syncNodeStates(): void {
    this.nodes.forEach(node => {
      const isActive = node.pageId === this.selectedPageId;
      const isHovered = node.pageId === this.hoveredNodeId;
      this.applyNodeVisualState(node, isActive, isHovered);
    });
  }

  private updateHover(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const objects: THREE.Object3D[] = [];
    if (this.centralHitSphere) objects.push(this.centralHitSphere);
    // Only include nodes that are actually rendered (nodeGroup visible + individual group visible)
    if (this.nodeGroup.visible) {
      this.nodes.forEach(node => { if (node.group.visible) objects.push(node.group); });
    }

    const hits = this.raycaster.intersectObjects(objects, true);
    const hit = hits[0];

    let nodeId: string | null = null;
    let central = false;
    if (hit) {
      let current: THREE.Object3D | null = hit.object;
      while (current) {
        const pageId = current.userData?.pageId as string | undefined;
        if (pageId && this.nodes.has(pageId)) {
          nodeId = pageId;
          break;
        }
        if (current === this.centralHitSphere) {
          central = true;
          break;
        }
        current = current.parent;
      }
    }

    this.hoveredNodeId = nodeId;
    this.hoveredCentral = central;
    this.syncNodeStates();

    if (this.onHoverChange) {
      if (nodeId) {
        const node = this.nodes.get(nodeId);
        this.onHoverChange({ title: node?.title ?? 'Sans titre', x: event.clientX, y: event.clientY });
      } else {
        this.onHoverChange(null);
      }
    }
  }

  handlePointerMove = (event: PointerEvent): void => {
    this.updateHover(event);
    if (!this.dragActive) return;
    const dx = (event.clientX - this.dragStart.x) * 0.005;
    const dy = (event.clientY - this.dragStart.y) * 0.004;
    this.dragTargetRotation.x = this.dragRotationStart.x + dy;
    this.dragTargetRotation.y = this.dragRotationStart.y + dx;
  };

  handlePointerDown = (event: PointerEvent): void => {
    this.dragActive = true;
    this.dragStart.set(event.clientX, event.clientY);
    this.dragRotationStart.copy(this.dragTargetRotation);
    try {
      this.renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      /* noop */
    }
  };

  handlePointerUp = (event: PointerEvent): void => {
    this.dragActive = false;
    try {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    } catch {
      /* noop */
    }
  };

  handlePointerLeave = (): void => {
    this.dragActive = false;
    this.hoveredNodeId = null;
    this.hoveredCentral = false;
    this.syncNodeStates();
    this.onHoverChange?.(null);
  };

  handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.zoomTarget = THREE.MathUtils.clamp(this.zoomTarget + event.deltaY * 0.002, 4.5, 6.6);
  };

  handleClick = (): void => {
    if (this.hoveredNodeId) {
      this.onNodeSelect?.(this.hoveredNodeId);
      return;
    }
    if (this.hoveredCentral) {
      this.wakePulse = 1;
      this.onCentralActivate?.();
    }
  };

  handleDoubleClick = (): void => {
    this.dragTargetRotation.set(0, 0);
    this.root.rotation.set(0, 0, 0);
    this.zoomTarget = this.compact ? 5 : 5.5;
  };

  applyGestureInput(rotDx: number, rotDy: number, zoomDelta: number): void {
    let debug = false;
    try { debug = localStorage.getItem('docteur-gesture-debug') === 'true'; } catch { /* ignore */ }
    const before = debug ? { x: this.dragTargetRotation.x, y: this.dragTargetRotation.y, zoom: this.zoomTarget } : null;

    this.dragTargetRotation.x = THREE.MathUtils.clamp(
      this.dragTargetRotation.x + rotDy, -Math.PI / 2, Math.PI / 2,
    );
    this.dragTargetRotation.y += rotDx;
    if (zoomDelta !== 0) {
      this.zoomTarget = THREE.MathUtils.clamp(this.zoomTarget + zoomDelta, 4.5, 6.6);
    }

    if (debug && before) {
      console.info('[gesture] applyGestureInput', {
        input: { rotDx, rotDy, zoomDelta },
        before,
        after: { x: this.dragTargetRotation.x, y: this.dragTargetRotation.y, zoom: this.zoomTarget },
      });
    }
  }

  setIndexingIds(ids: Set<string>): void {
    this.indexingIds = ids;
  }

  setHighlightedIds(ids: Set<string>): void {
    this.highlightedIds = ids;
  }

  private getNeighborIds(nodeId: string): Set<string> {
    const s = new Set<string>();
    this.links.forEach(link => {
      if (link.startId === nodeId) s.add(link.endId);
      if (link.endId === nodeId) s.add(link.startId);
    });
    return s;
  }

  private applyVisualSettings(): void {
    const s = this.vs;

    // Bloom
    if (this.bloomPass) this.bloomPass.enabled = this.bloomEnabled && s.bgAnimations;

    // Background groups
    this.atmosphereGroup.visible = s.bgAnimations;
    this.jetGroup.visible        = s.bgAnimations;

    // Labels
    this.labelGroup.visible = s.showLabels;

    const hasFilter = s.kindFilter.length > 0 || s.isolateSelected || !!s.focusChannelId;

    if (!s.showNodes && !hasFilter) {
      // Fast path: cut the whole group — guaranteed no sphere remains
      this.nodeGroup.visible = false;
      // Hide focus line too (golden dots from centre to selected node)
      if (this.focusLine) {
        this.focusLine.line.visible = false;
        this.focusLine.dots.forEach(d => { d.mesh.visible = false; });
      }
    } else {
      this.nodeGroup.visible = true;

      // Compute isolation/focus neighbor sets
      const neighborIds = (s.isolateSelected && this.selectedPageId)
        ? this.getNeighborIds(this.selectedPageId)
        : null;
      const focusChildIds = s.focusChannelId
        ? this.getNeighborIds(s.focusChannelId)
        : null;

      // Per-node visibility
      this.nodes.forEach((node, id) => {
        let show = s.showNodes;
        if (show && s.kindFilter.length > 0 && !s.kindFilter.includes(node.kind)) show = false;
        if (show && neighborIds !== null && this.selectedPageId) {
          show = id === this.selectedPageId || neighborIds.has(id);
        }
        if (show && focusChildIds !== null && s.focusChannelId) {
          show = id === s.focusChannelId || focusChildIds.has(id);
        }
        node.group.visible = show;
      });

      // Restore focus line visibility (might have been hidden in a previous pass)
      if (this.focusLine) {
        this.focusLine.line.visible = true;
        this.focusLine.dots.forEach(d => { d.mesh.visible = true; });
      }
    }

    // Per-link visibility
    this.links.forEach(link => {
      const startOk = this.nodes.get(link.startId)?.group.visible ?? false;
      const endOk   = this.nodes.get(link.endId)?.group.visible ?? false;
      // A link is visible only if BOTH endpoints are rendered (nodeGroup visible + individual group)
      const startRendered = this.nodeGroup.visible && startOk;
      const endRendered   = this.nodeGroup.visible && endOk;
      const linkOk  = s.showLinks && startRendered && endRendered;
      link.tube.visible = linkOk;
      link.dots.forEach(dot => { dot.visible = s.flowParticles && linkOk; });
    });
  }

  setVisualSettings(s: VisualSettings): void {
    this.vs = s;
    this.applyVisualSettings();
  }

  private updateParticleLayer(layer: ParticleLayer, time: number, delta: number): void {
    const positions = (layer.geometry.getAttribute('position') as THREE.BufferAttribute);
    for (let i = 0; i < layer.seeds.length; i += 1) {
      const seed = layer.seeds[i];
      const drift = layer.drift * (0.5 + Math.sin(time * 0.7 + seed.phase) * 0.5);
      seed.velocity.x += Math.sin(time * 0.8 + i * 0.13 + seed.phase) * drift * 0.5 * delta;
      seed.velocity.y += Math.cos(time * 0.9 + i * 0.11) * drift * 0.4 * delta;
      seed.velocity.z += Math.sin(time * 0.6 + i * 0.07) * drift * 0.5 * delta;
      seed.velocity.multiplyScalar(0.985);
      seed.base.addScaledVector(seed.velocity, 60 * delta);
      const length = seed.base.length();
      if (length > layer.maxRadius) {
        seed.base.normalize().multiplyScalar(layer.maxRadius);
        seed.velocity.multiplyScalar(-0.78);
      }
      if (length < layer.minRadius) {
        seed.base.normalize().multiplyScalar(layer.minRadius);
        seed.velocity.multiplyScalar(-0.78);
      }
      positions.setXYZ(i, seed.base.x, seed.base.y, seed.base.z);
    }
    positions.needsUpdate = true;
    layer.points.rotation.x += layer.spin.x * delta;
    layer.points.rotation.y += layer.spin.y * delta;
    layer.points.rotation.z += layer.spin.z * delta;
  }

  private updateJetStreams(delta: number): void {
    const JET_LENGTH = 2.2;
    const SPAWN_DIST = 0.85;
    const NOISE = 0.12;

    this.jetStreams.forEach(jet => {
      const posAttr = jet.geometry.getAttribute('position') as THREE.BufferAttribute;
      const phaseAttr = jet.geometry.getAttribute('aPhase') as THREE.BufferAttribute;
      const posArr = posAttr.array as Float32Array;
      const phaseArr = phaseAttr.array as Float32Array;

      for (let i = 0; i < jet.count; i++) {
        jet.phases[i] += jet.speeds[i] * delta;
        if (jet.phases[i] > 1.0) jet.phases[i] -= 1.0;
        const phase = jet.phases[i];
        phaseArr[i] = phase;

        const dist = SPAWN_DIST + phase * JET_LENGTH;
        const sx = jet.spreads[i] * NOISE * Math.sin(phase * 13.0 + i * 0.43);
        const sy = jet.spreads[i] * NOISE * Math.cos(phase * 11.0 + i * 0.67);
        const sz = jet.spreads[i] * NOISE * Math.sin(phase * 9.0 + i * 0.89);
        posArr[i * 3]     = jet.direction.x * dist + sx;
        posArr[i * 3 + 1] = jet.direction.y * dist + sy;
        posArr[i * 3 + 2] = jet.direction.z * dist + sz;
      }

      posAttr.needsUpdate = true;
      phaseAttr.needsUpdate = true;
    });
  }

  private updateComets(time: number): void {
    this.atmosphereComets.forEach((comet, index) => {
      const radius = 4.5 + index * 0.5;
      const angle = time * (0.18 + index * 0.03) + index * 1.7;
      comet.mesh.position.set(
        Math.cos(angle * 0.7) * radius,
        Math.sin(angle * 0.55) * 1.4 + 0.5 * Math.sin(angle * 0.8),
        Math.sin(angle) * radius,
      );
      comet.mesh.position.addScaledVector(comet.velocity, Math.sin(time * 0.8 + index) * 0.4);

      comet.points.unshift(comet.mesh.position.clone());
      while (comet.points.length > 10) comet.points.pop();
      const geometry = comet.trail.geometry as THREE.BufferGeometry;
      geometry.setFromPoints(comet.points);
      (comet.trail.material as THREE.LineBasicMaterial).opacity = 0.10 + Math.sin(time * 1.1 + index) * 0.05;
    });
  }

  private updateLinks(): void {
    // Regular inter-node links — use root-local positions (no getWorldPosition needed)
    this.links.forEach(link => {
      const start = this.nodes.get(link.startId);
      const end = this.nodes.get(link.endId);
      if (!start || !end) return;
      const startPos = start.group.position;
      const endPos = end.group.position;
      const control1 = startPos.clone().lerp(endPos, 0.26).add(new THREE.Vector3(0, 0.45, 0.22));
      const control2 = startPos.clone().lerp(endPos, 0.72).add(new THREE.Vector3(0, -0.26, -0.16));
      link.curve = new THREE.CubicBezierCurve3(startPos.clone(), control1, control2, endPos.clone());
      const geometry = new THREE.TubeGeometry(link.curve, 14, link.radius, 6, false);
      link.tube.geometry.dispose();
      link.tube.geometry = geometry;
      link.phase = (link.phase + link.speed) % 1;
      link.material.uniforms.uTime.value = this.orbitPhase;
      link.material.uniforms.uOpacity.value = 0.18 + Math.sin(this.orbitPhase * 2.0 + link.phase * Math.PI * 2) * 0.04;
      link.dots.forEach((dot, index) => {
        const t = (link.phase + index / link.dots.length) % 1;
        dot.position.copy(link.curve.getPointAt(t));
        (dot.material as THREE.MeshPhysicalMaterial).opacity = 0.75 + Math.sin(this.orbitPhase * 3.2 + index) * 0.08;
      });
    });
  }

  // ── Focus line: centre → neurone actif ────────────────────────────────────

  private createFocusLine(nodeId: string): void {
    this.disposeFocusLine();

    // Two-vertex line, positions updated in-place every frame
    const positions = new Float32Array([0, 0, 0,  0, 0, 0]);
    const colors = new Float32Array([
      0.28, 0.60, 1.00,  // centre: bleu cyan
      1.00, 0.82, 0.38,  // neurone: doré chaud
    ]);
    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const line = new THREE.Line(geometry, material);
    this.linkGroup.add(line);

    // 4 dots that travel from centre to neurone
    const dots: FocusDot[] = Array.from({ length: 4 }, (_, i) => {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 8, 8),
        new THREE.MeshPhysicalMaterial({
          color: 0xffd98a,
          emissive: 0xf0d090,
          emissiveIntensity: 1.6,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      this.linkGroup.add(mesh);
      return { mesh, phase: i / 4, speed: 0.010 + i * 0.003 };
    });

    this.focusLine = { line, geometry, posAttr, material, dots, nodeId };
  }

  private updateFocusLine(): void {
    const selected = this.selectedPageId ? this.nodes.get(this.selectedPageId) : null;

    if (!selected) {
      this.disposeFocusLine();
      return;
    }

    if (!this.focusLine || this.focusLine.nodeId !== selected.pageId) {
      this.createFocusLine(selected.pageId);
    }

    if (!this.focusLine) return;
    const fl = this.focusLine;

    // Root-local position of the node — directly matches linkGroup's coordinate space
    const np = selected.group.position;
    const posArr = fl.posAttr.array as Float32Array;
    // start stays at (0,0,0); only update end
    posArr[3] = np.x;
    posArr[4] = np.y;
    posArr[5] = np.z;
    fl.posAttr.needsUpdate = true;

    // Pulse opacity
    fl.material.opacity = 0.40 + Math.sin(this.orbitPhase * 2.6) * 0.28;

    // Dots traveling from centre to node
    fl.dots.forEach(dot => {
      dot.phase = (dot.phase + dot.speed) % 1;
      const t = dot.phase;
      dot.mesh.position.set(np.x * t, np.y * t, np.z * t);
      (dot.mesh.material as THREE.MeshPhysicalMaterial).opacity = Math.sin(t * Math.PI) * 0.88;
    });
  }

  private disposeFocusLine(): void {
    if (!this.focusLine) return;
    this.linkGroup.remove(this.focusLine.line);
    this.focusLine.dots.forEach(d => {
      this.linkGroup.remove(d.mesh);
      disposeObject(d.mesh);
    });
    this.focusLine.geometry.dispose();
    this.focusLine.material.dispose();
    this.focusLine = undefined;
  }

  private animate = (time = 0): void => {
    this.animId = requestAnimationFrame(this.animate);
    const t = time * 0.001;
    const delta = this.lastFrame === 0 ? 1 / 60 : Math.max(0.001, (time - this.lastFrame) / 1000);
    this.lastFrame = time;
    this.fpsEstimate = this.fpsEstimate * 0.94 + (1 / delta) * 0.06;
    this.orbitPhase = t;
    this.frameCount++;

    this.camera.position.z = THREE.MathUtils.lerp(this.camera.position.z, this.zoomTarget, 0.08);
    this.camera.position.y = 1.5 + Math.sin((Math.PI * 2 * t) / 8) * 0.05;
    this.camera.lookAt(0, 0, 0);

    this.root.rotation.x = THREE.MathUtils.lerp(this.root.rotation.x, this.dragTargetRotation.x, 0.08);
    this.root.rotation.y = THREE.MathUtils.lerp(this.root.rotation.y, this.dragTargetRotation.y, 0.08);

    this.coreGroup.scale.setScalar(1 + Math.sin(t * 2.05) * 0.025);
    this.reactorGroup.scale.setScalar(1 + Math.sin(t * 1.6 + 0.7) * 0.012);
    this.outerRingGroup.scale.setScalar(1 + Math.sin(t * 1.45 + 1.1) * 0.008);

    if (this.centralHalo && this.centralAura) {
      (this.centralHalo.material as THREE.MeshPhysicalMaterial).opacity = 0.022 + Math.sin(t * 2.0) * 0.006 + this.wakePulse * 0.02;
      (this.centralAura.material as THREE.MeshPhysicalMaterial).opacity = 0.025 + Math.sin(t * 1.7 + 0.5) * 0.005 + this.wakePulse * 0.015;
    }
    if (this.centralGlass && this.centralGlass.material instanceof THREE.MeshPhysicalMaterial) {
      this.centralGlass.material.emissiveIntensity = 0.38 + this.wakePulse * 0.06 + Math.sin(t * 1.5) * 0.02;
    }
    if (this.centralPlasma && this.centralPlasma.material instanceof THREE.ShaderMaterial) {
      this.centralPlasma.material.uniforms.uTime.value = t;
      this.centralPlasma.material.uniforms.uHover.value = this.hoveredCentral ? 1 : 0;
      this.centralPlasma.material.uniforms.uWake.value = this.wakePulse;
    }

    this.ringMeshes.forEach((mesh, index) => {
      mesh.rotation.z += (index % 2 === 0 ? 1 : -1) * (index === 0 ? 0.006 : 0.0025);
    });

    // Coil update every 3 frames — cheap but frame-skip avoids tiny overhead
    if (this.frameCount % 3 === 0) {
      this.coilMeshes.forEach((mesh, index) => {
        mesh.rotation.z += (index % 3 === 0 ? 0.002 : -0.0016) * 3;
      });
    }

    this.nodes.forEach(node => {
      const localPhase = t * node.orbitSpeed + node.orbitPhase;
      const x = Math.cos(localPhase) * node.orbitRadiusX;
      const z = Math.sin(localPhase * 1.04) * node.orbitRadiusY;
      const y = node.orbitLift + Math.sin(localPhase * 1.9 + node.pulseSeed * Math.PI * 2) * 0.12;
      node.group.position.set(x, y, z);
      node.group.rotation.y = localPhase * 0.35;
      node.group.rotation.z = Math.sin(localPhase * 0.5) * 0.12;
      const selected = node.pageId === this.selectedPageId;
      const hovered = node.pageId === this.hoveredNodeId;
      const pulse = 1 + Math.sin(t * 2.2 + node.pulseSeed * Math.PI * 2) * 0.04;
      const nodeScale = selected ? 1.4 : hovered ? 1.2 : 1;
      const nodeEmissiveIntensity = selected ? 1.2 : hovered ? 0.85 : 0.6;
      node.group.scale.setScalar(nodeScale * pulse);
      (node.core.material as THREE.MeshPhysicalMaterial).emissiveIntensity = nodeEmissiveIntensity;
      (node.halo.material as THREE.MeshPhysicalMaterial).opacity = selected ? 0.20 : hovered ? 0.14 : 0.09;
      (node.aura.material as THREE.MeshPhysicalMaterial).opacity = selected ? 0.14 : hovered ? 0.10 : 0.07;
      (node.glow.material as THREE.MeshPhysicalMaterial).opacity = selected ? 0.35 : hovered ? 0.26 : 0.18;

      // Indexing ring — pulsing yellow when cortex is processing this node
      const isIndexing = this.indexingIds.has(node.pageId);
      node.indexRing.visible = isIndexing;
      if (isIndexing) {
        (node.indexRing.material as THREE.MeshBasicMaterial).opacity =
          0.35 + Math.sin(t * 7.0 + node.pulseSeed * Math.PI) * 0.28;
        node.indexRing.rotation.z = t * 1.8;
      }

      // Highlight ring — bright white pulse when node is a search/answer source
      const isHighlighted = this.highlightedIds.has(node.pageId);
      node.highlightRing.visible = isHighlighted;
      if (isHighlighted) {
        (node.highlightRing.material as THREE.MeshBasicMaterial).opacity =
          0.45 + Math.sin(t * 9.0 + node.pulseSeed * Math.PI * 1.3) * 0.38;
        node.highlightRing.rotation.z = -t * 2.8;
      }
    });

    // Plasma layers — always update (critical for core look)
    this.plasmaLayers.forEach((layer, index) => {
      layer.points.rotation.x = Math.sin(t * 0.18 + index) * 0.08;
      layer.points.rotation.y = t * (0.12 + index * 0.04);
      this.updateParticleLayer(layer, t, delta);
    });

    // Jet streams — every frame for smooth particle movement (skipped in low-perf mode)
    if (this.vs.bgAnimations) this.updateJetStreams(delta);

    // Focus line (centre → selected node) — EVERY FRAME, uses local positions, in-place update
    this.updateFocusLine();

    // Atmosphere + comets — every 2 frames, skipped when bg animations off
    if (this.vs.bgAnimations && this.frameCount % 2 === 0) {
      this.atmosphereLayers.forEach((layer, index) => {
        layer.points.rotation.x = Math.sin(t * 0.06 + index) * 0.03;
        layer.points.rotation.y = -t * (0.05 + index * 0.02);
        this.updateParticleLayer(layer, t, delta * 2);
      });
      this.updateComets(t);
    }

    // Inter-node links — every 2 frames
    if (this.frameCount % 2 === 0) {
      this.updateLinks();
    }

    if (this.wakePulse > 0) {
      this.wakePulse = Math.max(0, this.wakePulse - 0.01);
    }

    if (this.bloomPass) {
      this.bloomPass.enabled = this.bloomEnabled;
    }

    if (this.onPerformance && time % 500 < 16) {
      this.onPerformance({ fps: this.fpsEstimate, bloomActive: !!this.bloomPass?.enabled });
    }

    this.composer.render();
  };

  handleResize(): void {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.bloomPass.setSize(width, height);
    this.vignettePass.uniforms.offset.value = Math.min(1.18, 1.08 + Math.max(0, 900 - width) / 9000);
  }

  dispose(): void {
    cancelAnimationFrame(this.animId);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.handlePointerDown);
    canvas.removeEventListener('pointermove', this.handlePointerMove);
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    canvas.removeEventListener('wheel', this.handleWheel);
    canvas.removeEventListener('click', this.handleClick);
    canvas.removeEventListener('dblclick', this.handleDoubleClick);

    this.clearDynamic();

    this.labels.forEach(label => {
      const material = label.material as THREE.SpriteMaterial;
      material.map?.dispose();
      material.dispose();
    });
    this.labels = [];

    this.plasmaLayers.forEach(layer => {
      layer.geometry.dispose();
      disposeMaterial(layer.material);
    });
    this.plasmaLayers = [];

    this.atmosphereLayers.forEach(layer => {
      layer.geometry.dispose();
      disposeMaterial(layer.material);
    });
    this.atmosphereLayers = [];

    this.atmosphereComets.forEach(comet => {
      comet.trail.geometry.dispose();
      disposeMaterial(comet.trail.material as THREE.Material);
      disposeObject(comet.mesh);
    });
    this.atmosphereComets = [];

    this.ringMeshes.forEach(mesh => {
      mesh.geometry.dispose();
      disposeMaterial(mesh.material as THREE.Material);
    });
    this.ringMeshes = [];

    this.coilMeshes.forEach(mesh => {
      mesh.geometry.dispose();
      disposeMaterial(mesh.material as THREE.Material);
    });
    this.coilMeshes = [];

    this.jetStreams.forEach(jet => {
      jet.geometry.dispose();
      jet.material.dispose();
    });
    this.jetStreams = [];

    disposeObject(this.coreGroup);
    disposeObject(this.reactorGroup);
    disposeObject(this.outerRingGroup);
    disposeObject(this.jetGroup);
    disposeObject(this.labelGroup);
    disposeObject(this.atmosphereGroup);

    this.corePlasmaMaterial.dispose();
    this.radialTexture.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}

function NeuralBrain({
  pages,
  selectedPageId,
  compact = false,
  className = '',
  onNodeSelect,
  onCentralActivate,
  onHoverChange,
  onPerformance,
  bloomEnabled = true,
  indexingIds,
  highlightedIds,
  gestureInputRef,
}: Props) {
  const canvasRef        = useRef<HTMLCanvasElement>(null);
  const tooltipRef       = useRef<HTMLDivElement>(null);
  const brainRef         = useRef<OrbitalBrain | null>(null);
  const settingsRef      = useRef<VisualSettings>(loadVisualSettings());
  // Track previous pages/selection to avoid full scene rebuild on content-only changes
  const lastBuiltBrain = useRef<OrbitalBrain | null>(null);
  const prevPagesRef     = useRef<Page[]>([]);
  const prevSelectedRef  = useRef<string | null>(null);
  // Refs for latest props — used in updateSetting when maxNodes changes
  const pagesLocalRef        = useRef<Page[]>(pages);
  const selectedPageIdLocalRef = useRef<string | null>(selectedPageId ?? null);

  const [tooltip,     setTooltip]     = useState<{ title: string; x: number; y: number } | null>(null);
  const [settings,    setSettings]    = useState<VisualSettings>(settingsRef.current);
  const [panelOpen,   setPanelOpen]   = useState(false);

  // Keep refs in sync so imperative calls outside React always see fresh values
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const renderPages = useMemo(() => {
    const top = [...pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, settings.maxNodes);
    const selected = pages.find(p => p.id === selectedPageId);
    if (selected && !top.some(p => p.id === selected.id)) { top.pop(); top.push(selected); }
    return top;
  }, [pages, settings.maxNodes, selectedPageId]);

  const updateSetting = useCallback(<K extends keyof VisualSettings>(key: K, value: VisualSettings[K]) => {
    const next = { ...settingsRef.current, [key]: value };
    try { localStorage.setItem(VISUAL_SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    brainRef.current?.setVisualSettings(next);
    setSettings(next);
  }, []);

  const resetView = useCallback(() => {
    setSettings(prev => {
      const next = { ...prev, kindFilter: [], isolateSelected: false, focusChannelId: null };
      try { localStorage.setItem(VISUAL_SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      brainRef.current?.setVisualSettings(next);
      return next;
    });
  }, []);

  const setPerformanceMode = useCallback((on: boolean) => {
    setSettings(prev => {
      const next = { ...prev, flowParticles: !on, bgAnimations: !on };
      try { localStorage.setItem(VISUAL_SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      brainRef.current?.setVisualSettings(next);
      return next;
    });
  }, []);

  const channels = pages.filter(p => p.kind === 'channel');
  const performanceMode = !settings.flowParticles && !settings.bgAnimations;

  const ALL_KINDS = ['channel', 'link', 'video', 'note', 'task', 'idea', 'reference', 'memory', 'rapport', 'prompt', 'corpus'] as const;
  const KIND_LABELS: Record<string, string> = { channel: 'Sources', link: 'Articles', video: 'Vidéos', note: 'Notes', task: 'Tâches', idea: 'Idées', reference: 'Réfs', memory: 'Mémoires', rapport: 'Rapports', prompt: 'Prompts' };
  const usedKinds = ALL_KINDS.filter(k => pages.some(p => p.kind === k));

  useEffect(() => {
    if (!canvasRef.current) return;
    const brain = new OrbitalBrain(
      canvasRef.current,
      compact,
      pageId => onNodeSelect?.(pageId),
      () => onCentralActivate?.(),
      payload => {
        setTooltip(payload);
        onHoverChange?.(payload);
      },
      onPerformance,
      bloomEnabled,
    );
    brain.setVisualSettings(settingsRef.current);
    brainRef.current = brain;

    canvasRef.current.style.width = '100%';
    canvasRef.current.style.height = '100%';
    canvasRef.current.style.display = 'block';

    const observer = new ResizeObserver(() => brain.handleResize());
    observer.observe(canvasRef.current);

    canvasRef.current.addEventListener('pointerdown', brain['handlePointerDown'] as EventListener);
    canvasRef.current.addEventListener('pointermove', brain['handlePointerMove'] as EventListener);
    canvasRef.current.addEventListener('pointerup', brain['handlePointerUp'] as EventListener);
    canvasRef.current.addEventListener('pointerleave', brain['handlePointerLeave'] as EventListener);
    canvasRef.current.addEventListener('wheel', brain['handleWheel'] as EventListener, { passive: false });
    canvasRef.current.addEventListener('click', brain['handleClick'] as EventListener);
    canvasRef.current.addEventListener('dblclick', brain['handleDoubleClick'] as EventListener);

    // Expose gesture input method via ref (called from useGestureCamera hook)
    if (gestureInputRef) {
      gestureInputRef.current = (rotDx, rotDy, zoomDelta) => brain.applyGestureInput(rotDx, rotDy, zoomDelta);
      try {
        if (localStorage.getItem('docteur-gesture-debug') === 'true') {
          console.info('[gesture] gestureInputRef wired to a live OrbitalBrain instance');
        }
      } catch { /* ignore */ }
    }

    return () => {
      if (gestureInputRef) {
        gestureInputRef.current = null;
        try {
          if (localStorage.getItem('docteur-gesture-debug') === 'true') {
            console.info('[gesture] gestureInputRef cleared — OrbitalBrain instance disposed (unmount or effect re-run)');
          }
        } catch { /* ignore */ }
      }
      observer.disconnect();
      brain.dispose();
      brainRef.current = null;
    };
  }, [bloomEnabled, compact, onCentralActivate, onHoverChange, onNodeSelect, onPerformance]);

  useEffect(() => {
    const brain = brainRef.current;
    if (!brain) return;

    const prev = prevPagesRef.current;
    const selId = selectedPageId ?? null;

    // Rebuild the Three.js scene ONLY when pages structure changes, not on every block edit.
    // Structural change = pages added/removed, kind/title/links changed.
    // Block content changes during typing are irrelevant to the brain visual.
    // NOTE: compare links by content (not reference) to avoid spurious rebuilds when
    // IDB returns new array objects for the same data (e.g. StrictMode double-load).
    const linksEq = (a?: string[], b?: string[]): boolean => {
      const la = a ?? []; const lb = b ?? [];
      return la.length === lb.length && la.every((x, i) => x === lb[i]);
    };
    const structChanged =
      renderPages.length !== prev.length ||
      renderPages.some((p, i) => {
        const q = prev[i];
        return !q || p.id !== q.id || p.kind !== q.kind ||
               p.title !== q.title || !linksEq(p.links, q.links);
      });

    if (structChanged || brain !== lastBuiltBrain.current) {


      // Defer the heavy Three.js scene rebuild to after the current render paint.
      // Synchronous setPages(900 nodes) was blocking the main thread for ~200-400ms,
      // preventing the UI from appearing after pages loaded.
      const t0 = performance.now();
      const settings = settingsRef.current;
      const timer = setTimeout(() => {
        // Apply visual settings first so setPages can read maxNodes from this.vs
        brain.setVisualSettings(settings);
        const buildStart = performance.now();
        brain.setPages(renderPages, selId);
        prevPagesRef.current = renderPages;
        prevSelectedRef.current = selId;
        lastBuiltBrain.current = brain;
        console.log(`[startup] brain.setPages(${renderPages.length} nodes, limit ${settings.maxNodes}): ${Math.trunc(performance.now() - buildStart)}ms`, { sourceCount: pages.length, renderCount: renderPages.length, queuedMs: Math.round(buildStart - t0) });
      }, 0);
      return () => clearTimeout(timer);
    } else if (selId !== prevSelectedRef.current) {
      prevSelectedRef.current = selId;
      brain.setSelectedPageId(selId);
    }
  }, [renderPages, selectedPageId, bloomEnabled, compact, onCentralActivate, onHoverChange, onNodeSelect, onPerformance]);

  useEffect(() => {
    brainRef.current?.setIndexingIds(indexingIds ?? new Set());
  }, [indexingIds]);

  useEffect(() => {
    brainRef.current?.setHighlightedIds(highlightedIds ?? new Set());
  }, [highlightedIds]);

  useEffect(() => {
    if (!tooltipRef.current) return;
    if (!tooltip) {
      tooltipRef.current.style.opacity = '0';
      tooltipRef.current.style.transform = 'translate3d(-9999px, -9999px, 0)';
      return;
    }
    tooltipRef.current.style.opacity = '1';
    tooltipRef.current.style.transform = `translate3d(${tooltip.x + 14}px, ${tooltip.y + 14}px, 0)`;
  }, [tooltip]);

  // Panel styles
  const panelBase: React.CSSProperties = {
    position: 'absolute', top: 8, right: 8, zIndex: 20,
    display: 'flex', flexDirection: 'column', gap: 0,
    background: 'rgba(10,8,18,0.92)', backdropFilter: 'blur(12px)',
    border: '1px solid rgba(94,231,255,0.12)', borderRadius: 10,
    boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
    fontFamily: 'IBM Plex Mono, monospace', fontSize: 11,
    color: '#c0b0e0', minWidth: 192, overflow: 'hidden',
  };
  const sectionHead: React.CSSProperties = {
    padding: '6px 12px 4px', fontSize: 9, letterSpacing: '0.12em',
    color: '#5a4a7a', borderBottom: '1px solid rgba(255,255,255,0.05)',
    textTransform: 'uppercase',
  };
  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '5px 12px', gap: 8,
  };

  function Toggle({ on, onChange, label = '' }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
    return (
      <button
        type="button"
        title={label || (on ? 'Désactiver' : 'Activer')}
        aria-label={label || (on ? 'Désactiver' : 'Activer')}
        onClick={() => onChange(!on)}
        style={{
          width: 30, height: 16, borderRadius: 8, border: 'none', cursor: 'pointer',
          background: on ? 'rgba(61,255,170,0.7)' : 'rgba(255,255,255,0.1)',
          position: 'relative', flexShrink: 0, transition: 'background 0.15s',
        }}
      >
        <span style={{
          position: 'absolute', top: 2, left: on ? 14 : 2, width: 12, height: 12,
          borderRadius: '50%', background: on ? '#fff' : '#5a4a7a',
          transition: 'left 0.15s, background 0.15s',
        }} />
      </button>
    );
  }

  return (
    <div className={`brain-shell ${className}`} style={{ position: 'relative' }}>
      <canvas ref={canvasRef} className="brain-canvas" />

      {/* Quick-access HUD buttons (always visible) */}
      {!panelOpen && (
        <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 21, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* Settings panel */}
          <button
            type="button"
            title="Panneau de contrôle visuel"
            onClick={() => setPanelOpen(true)}
            style={{
              width: 28, height: 28, borderRadius: 6, border: 'none', cursor: 'pointer',
              background: 'rgba(255,255,255,0.06)', color: '#5a4a7a',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 15, transition: 'background 0.15s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(61,255,170,0.12)'; (e.currentTarget as HTMLButtonElement).style.color = '#3dffaa'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)'; (e.currentTarget as HTMLButtonElement).style.color = '#5a4a7a'; }}
          >⚙</button>

          {/* Masquer neurones */}
          <button
            type="button"
            title={settings.showNodes ? 'Masquer les neurones' : 'Afficher les neurones'}
            onClick={() => updateSetting('showNodes', !settings.showNodes)}
            style={{
              width: 28, height: 28, borderRadius: 6, border: `1px solid ${settings.showNodes ? 'transparent' : 'rgba(255,139,61,0.4)'}`,
              cursor: 'pointer',
              background: settings.showNodes ? 'rgba(255,255,255,0.06)' : 'rgba(255,139,61,0.14)',
              color: settings.showNodes ? '#5a4a7a' : '#ff8b3d',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
            }}
          >◎</button>

          {/* Masquer particules */}
          <button
            type="button"
            title={settings.flowParticles ? 'Masquer les particules de flux' : 'Afficher les particules de flux'}
            onClick={() => updateSetting('flowParticles', !settings.flowParticles)}
            style={{
              width: 28, height: 28, borderRadius: 6, border: `1px solid ${settings.flowParticles ? 'transparent' : 'rgba(94,231,255,0.4)'}`,
              cursor: 'pointer',
              background: settings.flowParticles ? 'rgba(255,255,255,0.06)' : 'rgba(94,231,255,0.1)',
              color: settings.flowParticles ? '#5a4a7a' : '#5ee7ff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
            }}
          >✦</button>
        </div>
      )}

      {/* Control panel */}
      {panelOpen && (
        <div style={panelBase}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 12px 5px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span style={{ fontSize: 10, letterSpacing: '0.1em', color: '#3dffaa' }}>CORTEX</span>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#5a4a7a', fontSize: 14, lineHeight: 1, padding: '0 2px' }}
            >×</button>
          </div>

          {/* Section 1: Performances */}
          <div style={sectionHead}>Performances</div>

          <div style={rowStyle}>
            <span>Mode performance</span>
            <Toggle on={performanceMode} onChange={setPerformanceMode} />
          </div>
          <div style={{ ...rowStyle, paddingLeft: 20 }}>
            <span style={{ color: performanceMode ? '#3a3050' : '#c0b0e0' }}>Particules de flux</span>
            <Toggle on={settings.flowParticles} onChange={v => updateSetting('flowParticles', v)} />
          </div>
          <div style={{ ...rowStyle, paddingLeft: 20 }}>
            <span style={{ color: performanceMode ? '#3a3050' : '#c0b0e0' }}>Animations de fond</span>
            <Toggle on={settings.bgAnimations} onChange={v => updateSetting('bgAnimations', v)} />
          </div>

          {/* Node count limit */}
          <div style={{ padding: '4px 12px 6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
              <span style={{ fontSize: 10, color: '#c0b0e0' }}>Neurones affichés</span>
              <span style={{ fontSize: 9, color: pages.length > settings.maxNodes ? '#ff8b3d' : '#5a4a7a' }}>
                {Math.min(settings.maxNodes, pages.length)}/{pages.length}
              </span>
            </div>
            <input
              type="range"
              min={50}
              max={2000}
              step={50}
              value={settings.maxNodes}
              onChange={e => updateSetting('maxNodes', Number(e.target.value))}
              style={{ width: '100%', accentColor: '#3dffaa', cursor: 'pointer' }}
            />
          </div>

          {/* Section 2: Affichage */}
          <div style={sectionHead}>Affichage</div>

          <div style={rowStyle}>
            <span>Neurones</span>
            <Toggle on={settings.showNodes} onChange={v => updateSetting('showNodes', v)} />
          </div>
          <div style={rowStyle}>
            <span>Synapses</span>
            <Toggle on={settings.showLinks} onChange={v => updateSetting('showLinks', v)} />
          </div>
          <div style={rowStyle}>
            <span>Labels</span>
            <Toggle on={settings.showLabels} onChange={v => updateSetting('showLabels', v)} />
          </div>

          {usedKinds.length > 0 && (
            <>
              <div style={{ padding: '4px 12px 2px', fontSize: 9, color: '#5a4a7a' }}>Filtrer par type :</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 12px 8px' }}>
                {usedKinds.map(k => {
                  const active = settings.kindFilter.length === 0 || settings.kindFilter.includes(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => {
                        if (settings.kindFilter.length === 0) {
                          // First click: exclude this kind
                          updateSetting('kindFilter', usedKinds.filter(x => x !== k));
                        } else if (settings.kindFilter.includes(k)) {
                          const next = settings.kindFilter.filter(x => x !== k);
                          updateSetting('kindFilter', next.length === 0 ? usedKinds : next);
                        } else {
                          const next = [...settings.kindFilter, k];
                          updateSetting('kindFilter', next.length === usedKinds.length ? [] : next);
                        }
                      }}
                      style={{
                        fontSize: 9, padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
                        border: `1px solid ${active ? 'rgba(61,255,170,0.4)' : 'rgba(255,255,255,0.07)'}`,
                        background: active ? 'rgba(61,255,170,0.12)' : 'rgba(255,255,255,0.04)',
                        color: active ? '#3dffaa' : '#3a3050',
                      }}
                    >
                      {KIND_LABELS[k] ?? k}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* Section 3: Isolation */}
          <div style={sectionHead}>Isolation</div>

          <div style={rowStyle}>
            <span>Isoler la sélection</span>
            <Toggle on={settings.isolateSelected} onChange={v => updateSetting('isolateSelected', v)} />
          </div>

          {channels.length > 0 && (
            <div style={{ padding: '4px 12px 6px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 9, color: '#5a4a7a' }}>Focus source :</span>
              <select
                title="Choisir une source"
                aria-label="Choisir une source"
                value={settings.focusChannelId ?? ''}
                onChange={e => updateSetting('focusChannelId', e.target.value || null)}
                style={{
                  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 4, color: '#c0b0e0', fontSize: 10, padding: '3px 6px',
                  fontFamily: 'IBM Plex Mono, monospace', width: '100%', cursor: 'pointer',
                }}
              >
                <option value="">— aucune —</option>
                {channels.map(ch => (
                  <option key={ch.id} value={ch.id}>{ch.title || 'Sans titre'}</option>
                ))}
              </select>
            </div>
          )}

          {(settings.kindFilter.length > 0 || settings.isolateSelected || settings.focusChannelId) && (
            <div style={{ padding: '2px 12px 8px' }}>
              <button
                type="button"
                onClick={resetView}
                style={{
                  width: '100%', padding: '4px 0', borderRadius: 4, cursor: 'pointer',
                  background: 'rgba(255,139,61,0.1)', border: '1px solid rgba(255,139,61,0.25)',
                  color: '#ff8b3d', fontSize: 10, fontFamily: 'IBM Plex Mono, monospace',
                }}
              >
                Tout afficher
              </button>
            </div>
          )}

        </div>
      )}

      {tooltip && (
        <div ref={tooltipRef} className="brain-tooltip">
          {tooltip.title}
        </div>
      )}
    </div>
  );
}

function setsEqual(a?: Set<string>, b?: Set<string>): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export default memo(NeuralBrain, (prev, next) =>
  prev.pages === next.pages &&
  prev.selectedPageId === next.selectedPageId &&
  prev.compact === next.compact &&
  prev.className === next.className &&
  prev.onNodeSelect === next.onNodeSelect &&
  prev.bloomEnabled === next.bloomEnabled &&
  setsEqual(prev.indexingIds, next.indexingIds) &&
  setsEqual(prev.highlightedIds, next.highlightedIds)
);
