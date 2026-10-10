/**
 * The desk: a laptop on a desk under a lamp, the demo on its screen, and two
 * hands on its keys, drawn in 3D (Three.js in a Chromium page). The keyboard
 * window films it from over the keys; the desk views film it as the whole
 * frame. Everything it draws is a function of the key events it's been given,
 * the screen it's been handed, and the time it's asked for, so a frame is the
 * same on every render.
 *
 * The hands are the WebXR "generic hand" models (MIT, see assets/hands), a
 * skinned mesh whose joints are positioned one by one, as hand tracking
 * positions them; the fingers are posed here with forward kinematics from
 * the model's rest pose.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { layout, type KeyboardLayout, type Pressed } from "./keyboard.js";

/** What the desk looks like, set once per demo. */
export interface DeskOptions {
  /** The laptop: a Mac (silver, ⌘), or a PC (dark, Ctrl). Default: "mac" */
  laptop?: KeyboardLayout;
  /** Show the hands. Default: true */
  hands?: boolean;
  /** The hands' skin, a CSS color. Default: "#d9a784" */
  handColor?: string;
  /** The desk's surface, a CSS color. Default: "#e4ddd3" */
  surface?: string;
}

/** A key event the scene animates: the keys, who presses them, when the main key goes down, and for how long. */
export interface KeyEvent {
  at: number;
  hold: number;
  keys: Pressed[];
  /** The chord as a viewer reads it, shown under the keys by a keyboard window. */
  label?: string;
}

export const DESK_DEFAULTS = { laptop: "mac" as KeyboardLayout, hands: true, handColor: "#d9a784", surface: "#e4ddd3" };

export interface DeskPageOptions extends Required<DeskOptions> {
  /** Show a chord's label (the keyboard window does; the desk views don't). */
  labels: boolean;
  /** The screen's aspect ratio, the desktop's, so the laptop's screen fits it exactly. */
  aspect: number;
}

/** Camera presets, and "flat": the screen filling the frame exactly, where a desk view starts from. */
export type DeskView = "flat" | "screen" | "desk" | "keyboard";
export const DESK_VIEWS: DeskView[] = ["screen", "desk", "keyboard"];

/** Where the page lives; its Three.js and hand models are served under it too. */
export const DESK_URL = "http://desk.reelscript/";

/** A file the page asks for under DESK_URL: Three.js (by path in its package) or a hand model; null for anything else. */
export function deskAsset(pathname: string): { body: Buffer; contentType: string } | null {
  if (pathname.startsWith("/three/")) {
    const dir = dirname(dirname(fileURLToPath(import.meta.resolve("three"))));
    const rel = pathname.slice("/three/".length);
    if (rel.includes("..")) return null;
    return { body: readFileSync(join(dir, rel)), contentType: "text/javascript" };
  }
  if (/^\/hands\/(left|right)\.glb$/.test(pathname)) {
    return { body: readFileSync(new URL(`../assets/hands/${pathname.slice(7)}`, import.meta.url)), contentType: "model/gltf-binary" };
  }
  return null;
}

const pageCache = new Map<string, string>();

/** Self-contained HTML for the desk page, with `window.__rsDesk` to drive it. */
export function deskPageHtml(opts: DeskPageOptions): string {
  const key = JSON.stringify(opts);
  let html = pageCache.get(key);
  if (html) return html;
  const font = readFileSync(new URL("../assets/fonts/InterVariable.ttf", import.meta.url)).toString("base64");
  html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Inter"; font-weight: 100 900; src: url(data:font/ttf;base64,${font}) format("truetype"); }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; font-family: Inter, system-ui, sans-serif; }
canvas { display: block; }
#label { position: absolute; left: 50%; top: 7%; transform: translateX(-50%); padding: .35em .85em; border-radius: 999px;
  background: rgba(20,20,24,.84); color: #fff; font-size: 18px; font-weight: 600; letter-spacing: .04em; white-space: nowrap;
  opacity: 0; box-shadow: 0 6px 18px rgba(0,0,0,.3); }
</style>
<script type="importmap">{ "imports": { "three": "${DESK_URL}three/build/three.module.js" } }</script>
</head><body><div id="label"></div>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "${DESK_URL}three/examples/jsm/loaders/GLTFLoader.js";
const LAYOUT = ${JSON.stringify(layout(opts.laptop))};
const OPTS = ${JSON.stringify(opts)};
const HANDS_URL = ${JSON.stringify(`${DESK_URL}hands/`)};
${SCENE}
</script></body></html>`;
  pageCache.set(key, html);
  return html;
}

const SCENE = String.raw`
const U = 1; // one key unit, 19 mm
const KEY_H = 0.34, KEY_TRAVEL = 0.14, DECK_H = 0.55, MARGIN = 0.6;
const mac = LAYOUT.name === "mac";
const P = mac
  ? { body: 0xc9cacf, bodyEdge: 0xb6b7bc, key: 0x2a2a2d, keySide: 0x1f1f22, legend: "#f2f2f4", bezel: 0x0a0a0b, trackpad: 0xbfc0c5 }
  : { body: 0x2a2b2f, bodyEdge: 0x1c1d20, key: 0xe2e3e7, keySide: 0xc6c7cc, legend: "#1c1c1f", bezel: 0x111214, trackpad: 0x34353a };
const ACCENT = 0x2f7cf6;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15161a);
scene.fog = new THREE.Fog(0x15161a, 45, 130);
const camera = new THREE.PerspectiveCamera(30, OPTS.aspect, 0.1, 400);

// ---------------------------------------------------------------- light: a lamp to the left, the room, and the screen's glow
scene.add(new THREE.HemisphereLight(0xd8e4ff, 0x4a4035, 0.55));
const lamp = new THREE.SpotLight(0xffd9a8, 900, 120, 0.7, 0.9, 1.6);
lamp.position.set(-26, 34, 14);
lamp.target.position.set(2, 0, -2);
lamp.castShadow = true;
lamp.shadow.mapSize.set(2048, 2048);
lamp.shadow.bias = -0.0004;
lamp.shadow.normalBias = 0.04;
lamp.shadow.camera.near = 10;
lamp.shadow.camera.far = 90;
scene.add(lamp, lamp.target);
const rim = new THREE.DirectionalLight(0xbcd0ff, 0.7);
rim.position.set(18, 14, -22);
scene.add(rim);
const glow = new THREE.PointLight(0xdfe8ff, 0, 30, 1.8); // the screen, lighting the keys and hands
scene.add(glow);

// ---------------------------------------------------------------- the desk
function grain(color) {
  // A faint grain, so the surface isn't a flat colour; drawn from a fixed sequence, so it's the same every time.
  const c = document.createElement("canvas");
  c.width = 512; c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = color; g.fillRect(0, 0, 512, 512);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * 512, y = rnd() * 512, l = 20 + rnd() * 120, a = 0.025 + rnd() * 0.04;
    g.strokeStyle = "rgba(" + (rnd() < 0.5 ? "0,0,0" : "255,255,255") + "," + a.toFixed(3) + ")";
    g.lineWidth = 0.6 + rnd() * 1.2;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + l, y + (rnd() - 0.5) * 6); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  t.anisotropy = 4;
  return t;
}
const desk = new THREE.Mesh(new THREE.PlaneGeometry(400, 320), new THREE.MeshStandardMaterial({ map: grain(OPTS.surface), roughness: 0.85 }));
desk.rotation.x = -Math.PI / 2;
desk.position.set(0, -DECK_H - 0.2, -20);
desk.receiveShadow = true;
scene.add(desk);

// ---------------------------------------------------------------- the laptop
const W = LAYOUT.width, D = LAYOUT.height;
const BODY_W = W * U + MARGIN * 2 + 1.6, BODY_D = D * U + MARGIN * 2 + (mac ? 6.2 : 5.4); // room for the trackpad
const KEYS_Z = -(BODY_D / 2) + MARGIN + 0.9; // where the key block starts (its far edge), from the body's centre
const ux = (x) => (x - W / 2) * U;
const keyZ = (y) => KEYS_Z + y * U;

function roundedRect(w, d, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
const bodyMat = new THREE.MeshStandardMaterial({ color: P.body, roughness: 0.55, metalness: mac ? 0.45 : 0.1 });
const bodyGeo = new THREE.ExtrudeGeometry(roundedRect(BODY_W, BODY_D, 0.6), { depth: DECK_H, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 3 });
bodyGeo.rotateX(-Math.PI / 2);
bodyGeo.translate(0, -DECK_H - 0.1, 0);
const body = new THREE.Mesh(bodyGeo, bodyMat);
body.receiveShadow = true;
body.castShadow = true;
scene.add(body);
// The well the keys sit in.
const well = new THREE.Mesh(new THREE.PlaneGeometry(W * U + 0.25, D * U + 0.25), new THREE.MeshStandardMaterial({ color: P.bodyEdge, roughness: 0.95 }));
well.rotation.x = -Math.PI / 2;
well.position.set(0, -0.06, KEYS_Z + (D * U) / 2);
well.receiveShadow = true;
scene.add(well);
// Trackpad.
const padW = mac ? 7.6 : 6.2, padD = mac ? 4.9 : 3.9;
const pad = new THREE.Mesh(new THREE.PlaneGeometry(padW, padD), new THREE.MeshStandardMaterial({ color: P.trackpad, roughness: 0.35, metalness: mac ? 0.3 : 0.05 }));
pad.rotation.x = -Math.PI / 2;
pad.position.set(0, 0.012, KEYS_Z + D * U + 0.9 + padD / 2);
pad.receiveShadow = true;
scene.add(pad);

// Legends, drawn once each into the keycap's top texture.
const legendCache = new Map();
function legendTexture(cap, accent) {
  const k = cap.id + ":" + accent;
  if (legendCache.has(k)) return legendCache.get(k);
  const px = 96;
  const c = document.createElement("canvas");
  c.width = Math.round(px * cap.w); c.height = Math.round(px * cap.h);
  const g = c.getContext("2d");
  g.fillStyle = accent ? "#2f7cf6" : "#" + P.key.toString(16).padStart(6, "0");
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = accent ? "#ffffff" : P.legend;
  g.textAlign = "center"; g.textBaseline = "middle";
  const small = cap.legend.length > 2 && !/^F\d+$/.test(cap.legend);
  const symbol = /^[⌘⌥⌃⇧🌐⊞]$/.test(cap.legend);
  if (cap.shifted) {
    g.font = "500 " + px * 0.26 + "px Inter"; g.fillText(cap.shifted, c.width / 2, c.height * 0.3);
    g.font = "500 " + px * 0.3 + "px Inter"; g.fillText(cap.legend, c.width / 2, c.height * 0.68);
  } else if (cap.sub) {
    g.font = "500 " + px * (symbol ? 0.3 : 0.24) + "px Inter"; g.fillText(cap.legend, c.width / 2, c.height * 0.36);
    g.font = "500 " + px * 0.16 + "px Inter"; g.fillText(cap.sub, c.width / 2, c.height * 0.76);
  } else {
    g.font = "500 " + px * (small ? 0.2 : cap.h < 0.9 ? 0.22 : 0.36) + "px Inter";
    g.fillText(cap.legend, c.width / 2, c.height / 2 + (small ? 0 : 1));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  legendCache.set(k, tex);
  return tex;
}
const keys = new Map();
for (const cap of LAYOUT.keys) {
  const w = cap.w * U - 0.1, d = cap.h * U - 0.1;
  const matSide = new THREE.MeshStandardMaterial({ color: P.keySide, roughness: 0.85 });
  const matTop = new THREE.MeshStandardMaterial({ map: legendTexture(cap, false), roughness: 0.7 });
  const matLit = new THREE.MeshStandardMaterial({ map: legendTexture(cap, true), roughness: 0.6, emissive: ACCENT, emissiveIntensity: 0.3 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, KEY_H, d), [matSide, matSide, matTop, matSide, matSide, matSide]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(ux(cap.x + cap.w / 2), KEY_H / 2, keyZ(cap.y + cap.h / 2));
  scene.add(mesh);
  keys.set(cap.id, { mesh, cap, matTop, matLit });
}
function keyCenter(id) {
  const k = keys.get(id);
  return new THREE.Vector3(ux(k.cap.x + k.cap.w / 2), KEY_H, keyZ(k.cap.y + k.cap.h / 2));
}

// The lid, hinged at the body's back edge, open a little past upright; the screen fits the demo's aspect exactly.
const SCREEN_W = BODY_W - (mac ? 1.4 : 1.8);
const SCREEN_H = SCREEN_W / OPTS.aspect;
const BEZEL = mac ? 0.5 : 0.7;
const LID_W = BODY_W, LID_H = SCREEN_H + BEZEL * 2 + (mac ? 0.3 : 0.6), LID_T = 0.42;
const OPEN = Math.PI / 2 + 0.3; // 107°
const lid = new THREE.Group();
lid.position.set(0, -0.1, -BODY_D / 2 + 0.3);
lid.rotation.x = -(OPEN - Math.PI / 2);
scene.add(lid);
const lidGeo = new THREE.ExtrudeGeometry(roundedRect(LID_W, LID_H, 0.6), { depth: LID_T, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 2 });
lidGeo.translate(0, LID_H / 2, -LID_T - 0.08);
const lidMesh = new THREE.Mesh(lidGeo, bodyMat);
lidMesh.castShadow = true;
lidMesh.receiveShadow = true;
lid.add(lidMesh);
const bezel = new THREE.Mesh(new THREE.PlaneGeometry(LID_W - 0.5, LID_H - 0.5), new THREE.MeshStandardMaterial({ color: P.bezel, roughness: 0.3, metalness: 0.1 }));
bezel.position.set(0, LID_H / 2, 0.015);
lid.add(bezel);
const screenTex = new THREE.Texture();
screenTex.colorSpace = THREE.SRGBColorSpace;
screenTex.minFilter = THREE.LinearFilter;
screenTex.magFilter = THREE.LinearFilter;
screenTex.generateMipmaps = false;
const screenMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H), screenMat);
screen.position.set(0, BEZEL + SCREEN_H / 2 + (mac ? 0.15 : 0.3), 0.03);
lid.add(screen);
// A hinge bar.
const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, LID_W - 2, 24), new THREE.MeshStandardMaterial({ color: P.bodyEdge, roughness: 0.6, metalness: 0.4 }));
hinge.rotation.z = Math.PI / 2;
hinge.position.set(0, -0.1, -BODY_D / 2 + 0.3);
scene.add(hinge);

// ---------------------------------------------------------------- hands: the model's joints are set one by one, from its rest pose
const skin = new THREE.MeshStandardMaterial({ color: new THREE.Color(OPTS.handColor), roughness: 0.62, metalness: 0 });
// The model: metres, fingers along -y, palm facing -x, thumb toward -z (the left hand mirrors in z).
// On the keys: fingers forward (-Z), palm down (-Y), thumbs inward.
const MODEL_TO_WORLD = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
const HAND_SCALE = (1 / 0.019) * 0.8; // metres to key units, under life size so the keys show
const PALM_NORMAL = new THREE.Vector3(-1, 0, 0);
const CHAINS = [
  ["thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
  ["index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip"],
  ["middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip"],
  ["ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip"],
  ["pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip"],
];
const REST_CURL = [0.45, 0.42, 0.4, 0.42, 0.48];
const HOVER_Y = 0.75;
const hands = {};

async function loadHand(side) {
  const gltf = await new GLTFLoader().loadAsync(HANDS_URL + side + ".glb");
  const model = gltf.scene;
  const bones = {};
  model.traverse((o) => {
    if (o.isBone) bones[o.name] = o;
    if (o.isMesh) { o.material = skin; o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
  });
  const chains = CHAINS.map((names) => {
    const joints = names.map((n) => ({ bone: bones[n], restPos: bones[n].position.clone(), restQuat: bones[n].quaternion.clone() }));
    const dir = joints[joints.length - 1].restPos.clone().sub(joints[1].restPos).normalize();
    return { joints, dir, lateral: dir.clone().cross(PALM_NORMAL).normalize() };
  });
  // The forearm, which the model stops short of: from the wrist toward the viewer.
  const wrist = bones["wrist"].position;
  const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.029, 0.26, 6, 16), skin);
  arm.position.set(wrist.x - 0.004, wrist.y + 0.112, wrist.z + (side === "right" ? 0.004 : -0.004));
  arm.castShadow = true;
  model.add(arm);
  const root = new THREE.Group();
  root.quaternion.setFromRotationMatrix(MODEL_TO_WORLD);
  root.scale.setScalar(HAND_SCALE);
  root.add(model);
  const holder = new THREE.Group(); // positioned; the root inside carries the model's orientation
  holder.add(root);
  scene.add(holder);
  hands[side] = { side, sign: side === "right" ? 1 : -1, root: holder, chains };
}

const _q = new THREE.Quaternion(), _axis = new THREE.Vector3(), _v = new THREE.Vector3();
// Curl a finger's joints from the knuckle in, with a press that straightens it a little and dips it from the knuckle, and a sideways spread.
function poseFinger(hand, f, curl, press, spread = 0) {
  const chain = hand.chains[f];
  const thumb = f === 0;
  const c = curl * (1 - press * 0.4);
  const angles = thumb
    ? [0, 0.25 + press * 0.3, 0.3 + c * 0.7, 0]
    : [0, 0.95 * c + press * 0.5, 1.0 * c, 0.55 * c, 0];
  const A = new THREE.Quaternion();
  let prevNew = chain.joints[0].restPos.clone();
  for (let i = 0; i < chain.joints.length; i++) {
    const j = chain.joints[i];
    if (i > 0) prevNew = prevNew.clone().add(j.restPos.clone().sub(chain.joints[i - 1].restPos).applyQuaternion(A));
    if (angles[i]) {
      _axis.copy(chain.lateral).applyQuaternion(A);
      _q.setFromAxisAngle(_axis, angles[i]);
      A.premultiply(_q);
    }
    if (i === 1 && spread) {
      _axis.copy(PALM_NORMAL).applyQuaternion(A);
      _q.setFromAxisAngle(_axis, spread);
      A.premultiply(_q);
    }
    j.bone.position.copy(prevNew);
    j.bone.quaternion.copy(A).multiply(j.restQuat);
  }
}
function tipAt(hand, f) {
  hand.root.updateMatrixWorld(true);
  const chain = hand.chains[f];
  return chain.joints[chain.joints.length - 1].bone.getWorldPosition(_v.clone());
}
function placeHandFor(hand, f, target) {
  hand.root.position.set(0, 0, 0);
  const tip = tipAt(hand, f);
  hand.root.position.set(target.x - tip.x, target.y - tip.y, target.z - tip.z);
}
// Aim another finger of a placed hand at a key, by spreading at the knuckle and curling to reach.
function aimFinger(hand, f, target, press) {
  let best = null;
  for (let spread = -0.7; spread <= 0.7; spread += 0.14) {
    for (let curl = 0.05; curl <= 1.25; curl += 0.1) {
      poseFinger(hand, f, curl, press, spread);
      const tip = tipAt(hand, f);
      const err = (tip.x - target.x) ** 2 + (tip.z - target.z) ** 2 + 0.35 * (tip.y - target.y) ** 2;
      if (!best || err < best.err) best = { err, curl, spread };
    }
  }
  poseFinger(hand, f, best.curl, press, best.spread);
}

// ---------------------------------------------------------------- key events, as a function of time
const events = [];
const ease = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p * p * (3 - 2 * p));
const MOD_LEAD = 110, MOD_TAIL = 90, PRESS_EDGE = 45, RETURN_AFTER = 650, RETURN_OVER = 420;
function pressAmount(ev, key, t) {
  const down = key.modifier ? ev.at - MOD_LEAD : ev.at;
  const up = key.modifier ? ev.at + ev.hold + MOD_TAIL : ev.at + ev.hold;
  if (t < down - PRESS_EDGE || t > up + PRESS_EDGE) return 0;
  if (t < down) return ease((t - (down - PRESS_EDGE)) / PRESS_EDGE);
  if (t <= up) return 1;
  return 1 - ease((t - up) / PRESS_EDGE);
}
function handState(side, t) {
  let prev = null, cur = null, next = null;
  for (const ev of events) {
    const mine = ev.keys.filter((k) => k.hand === side);
    if (!mine.length) continue;
    const start = ev.at - (mine.some((k) => k.modifier) ? MOD_LEAD : 0);
    const end = ev.at + ev.hold + (mine.some((k) => k.modifier) ? MOD_TAIL : 0);
    if (end + PRESS_EDGE < t) prev = { ev, mine, start, end };
    else if (start - PRESS_EDGE <= t) { cur = { ev, mine, start, end }; break; }
    else { next = { ev, mine, start, end }; break; }
  }
  if (cur) return { keys: cur.mine, ev: cur.ev, blend: 1, from: prev };
  if (next) {
    const travel = Math.min(260, Math.max(130, next.start - (prev ? prev.end : -Infinity)));
    const moveStart = next.start - travel;
    if (t >= moveStart) return { keys: next.mine, ev: next.ev, blend: ease((t - moveStart) / travel), from: prev };
  }
  if (prev) {
    const since = t - prev.end;
    if (since < RETURN_AFTER) return { keys: prev.mine, ev: prev.ev, blend: 1, from: null, resting: true };
    if (since < RETURN_AFTER + RETURN_OVER) return { keys: prev.mine, ev: prev.ev, blend: 1 - ease((since - RETURN_AFTER) / RETURN_OVER), from: null, resting: true };
  }
  return null;
}
function homeKey(side) {
  return side === "left" ? { id: "f", finger: 1 } : { id: "j", finger: 1 };
}
function poseHome(hand) {
  for (let f = 0; f < 5; f++) poseFinger(hand, f, REST_CURL[f], 0);
  const home = homeKey(hand.side);
  const c = keyCenter(home.id);
  placeHandFor(hand, home.finger, new THREE.Vector3(c.x, c.y + HOVER_Y, c.z));
}
function poseHandAt(hand, state, t) {
  const primary = state.keys.find((k) => !k.modifier) ?? state.keys[0];
  for (let f = 0; f < 5; f++) poseFinger(hand, f, REST_CURL[f], 0);
  const press = state.resting ? 0 : pressAmount(state.ev, primary, t);
  poseFinger(hand, primary.finger, REST_CURL[primary.finger], press);
  const c = keyCenter(primary.id);
  placeHandFor(hand, primary.finger, new THREE.Vector3(c.x, c.y + HOVER_Y * (1 - press) + 0.02 * press, c.z));
  for (const k of state.keys) {
    if (k === primary) continue;
    const kc = keyCenter(k.id);
    const kp = state.resting ? 0 : pressAmount(state.ev, k, t);
    aimFinger(hand, k.finger, new THREE.Vector3(kc.x, kc.y + HOVER_Y * (1 - kp) + 0.02 * kp, kc.z), kp);
  }
}
function placeHand(hand, t) {
  const state = handState(hand.side, t);
  if (!state) { poseHome(hand); return; }
  poseHandAt(hand, state, t);
  if (state.blend < 1) {
    const to = hand.root.position.clone();
    if (state.from) poseHandAt(hand, { keys: state.from.mine, ev: state.from.ev, resting: true }, t); else poseHome(hand);
    const from = hand.root.position.clone();
    poseHandAt(hand, state, t);
    hand.root.position.lerpVectors(from, to, state.blend);
    hand.root.position.y += Math.sin(state.blend * Math.PI) * 0.3;
  }
}

// ---------------------------------------------------------------- cameras
// The screen's centre, normal and up, in the world, for the views that frame it.
function screenFrame() {
  lid.updateMatrixWorld(true);
  const centre = screen.getWorldPosition(new THREE.Vector3());
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(lid.getWorldQuaternion(new THREE.Quaternion()));
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(lid.getWorldQuaternion(new THREE.Quaternion()));
  return { centre, normal, up };
}
// Each view: where the camera is, what it looks at, which way is up, and its field of view.
function viewPose(name) {
  const { centre, normal, up } = screenFrame();
  if (name === "flat") {
    // Straight at the screen, as far as makes it fill the frame exactly.
    const fov = 30;
    const dist = SCREEN_H / 2 / Math.tan((fov * Math.PI) / 360);
    return { pos: centre.clone().addScaledVector(normal, dist), at: centre.clone(), up: up.clone(), fov };
  }
  if (name === "screen") {
    const fov = 30;
    const dist = (SCREEN_H / 2 / Math.tan((fov * Math.PI) / 360)) * 1.32;
    const side = new THREE.Vector3().crossVectors(up, normal).normalize();
    const pos = centre.clone().addScaledVector(normal, dist).addScaledVector(side, -dist * 0.16).addScaledVector(up, -dist * 0.08);
    return { pos, at: centre.clone().addScaledVector(up, -SCREEN_H * 0.08), up: new THREE.Vector3(0, 1, 0), fov };
  }
  if (name === "desk") {
    return { pos: new THREE.Vector3(-4, 19, 26), at: new THREE.Vector3(0, 4.5, -2.5), up: new THREE.Vector3(0, 1, 0), fov: 30 };
  }
  if (name === "side") return { pos: new THREE.Vector3(34, 5, 2), at: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 1, 0), fov: 28 };
  // keyboard: over the hands, keys filling the width, the screen's foot above
  return { pos: new THREE.Vector3(0, 17, 9), at: new THREE.Vector3(0, 0.3, -2.4), up: new THREE.Vector3(0, 1, 0), fov: 32 };
}
function setCamera(view) {
  const a = viewPose(view.from ?? "flat"), b = viewPose(view.to ?? "flat");
  const p = ease(view.amount ?? 1);
  camera.position.lerpVectors(a.pos, b.pos, p);
  camera.up.lerpVectors(a.up, b.up, p).normalize();
  camera.fov = a.fov + (b.fov - a.fov) * p;
  camera.updateProjectionMatrix();
  camera.lookAt(_v.lerpVectors(a.at, b.at, p));
}

// ---------------------------------------------------------------- render
const label = document.getElementById("label");
let screenShown = false;
function render(t, view) {
  for (const [id, k] of keys) {
    let amount = 0;
    for (const ev of events) for (const key of ev.keys) if (key.id === id) amount = Math.max(amount, pressAmount(ev, key, t));
    k.mesh.position.y = KEY_H / 2 - KEY_TRAVEL * amount;
    k.mesh.material[2] = amount > 0.5 ? k.matLit : k.matTop;
  }
  if (OPTS.hands) for (const h of Object.values(hands)) placeHand(h, t);
  let shown = null, opacity = 0;
  if (OPTS.labels) {
    for (const ev of events) {
      if (!ev.label) continue;
      const on = ev.at - MOD_LEAD - 80, off = ev.at + ev.hold + 700;
      if (t >= on - 120 && t <= off + 220) {
        shown = ev.label;
        opacity = t < on ? ease((t - (on - 120)) / 120) : t > off ? 1 - ease((t - off) / 220) : 1;
      }
    }
  }
  label.textContent = shown ?? "";
  label.style.opacity = String(opacity);
  const { centre, normal } = screenFrame();
  glow.position.copy(centre).addScaledVector(normal, 6);
  glow.intensity = screenShown ? 45 : 0;
  setCamera(view);
  renderer.render(scene, camera);
}
function resize(w, h) {
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
const ready = Promise.all([document.fonts.load("16px Inter").catch(() => {}), ...(OPTS.hands ? [loadHand("left"), loadHand("right")] : [])]);
window.__rsDesk = {
  ready,
  _debug: { REST_CURL, hands },
  resize,
  // The screen's picture, a data URL; resolves once it shows.
  setScreen(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        screenTex.image = img;
        screenTex.needsUpdate = true;
        screenMat.map = screenTex;
        screenMat.color.set(0xffffff);
        screenMat.needsUpdate = true;
        screenShown = true;
        resolve();
      };
      img.onerror = () => reject(new Error("the screen's picture didn't decode"));
      img.src = url;
    });
  },
  render(t, newEvents, view) {
    for (const ev of newEvents) events.push(ev);
    render(t, view ?? { to: "keyboard" });
  },
};
resize(window.innerWidth, window.innerHeight);
`;
