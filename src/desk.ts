/**
 * The desk: a laptop (a MacBook Pro model, assets/macbook) on an oak table in
 * a daylit room, the demo on its screen and two hands on its keys, or the
 * laptop and an iPad floating in a photo studio, drawn in 3D (Three.js in a
 * Chromium page) and lit by photographed rooms (assets/studio). The keyboard
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
  /** The hands' skin, a CSS color. Default: "#f2c4a0" */
  handColor?: string;
  /** The sleeves over the forearms, a CSS color. Default: "#5d6f8a" */
  sleeve?: string;
  /** The desk's surface: "oak" (a light oak veneer), or a CSS color for a plain one. Default: "oak" */
  surface?: string;
  /** The float view's backdrop, a CSS color; it's drawn as a soft gradient around it. Default: "#dfe3ea" */
  backdrop?: string;
}

/** A key event the scene animates: the keys, who presses them, when the main key goes down, and for how long. */
export interface KeyEvent {
  at: number;
  hold: number;
  keys: Pressed[];
  /** The chord as a viewer reads it, shown under the keys by a keyboard window. */
  label?: string;
  /** The earliest time a hand may start moving toward it: when the step that pressed it began. */
  from?: number;
}

export const DESK_DEFAULTS = { laptop: "mac" as KeyboardLayout, hands: true, handColor: "#f2c4a0", sleeve: "#5d6f8a", surface: "oak", backdrop: "#dfe3ea" };

export interface DeskPageOptions extends Required<DeskOptions> {
  /** Show a chord's label (the keyboard window does; the desk views don't). */
  labels: boolean;
  /** The screen's aspect ratio, the desktop's, so the laptop's screen fits it exactly. */
  aspect: number;
}

/**
 * Camera presets, and "flat": the screen filling the frame exactly, where a desk view starts from. "float" is a
 * different stage: no desk, the laptop and an iPad floating in a studio void.
 */
export type DeskView = "flat" | "screen" | "desk" | "keyboard" | "float";
export const DESK_VIEWS: DeskView[] = ["screen", "desk", "keyboard", "float"];

/** A shot: a view, the camera moved around it (degrees around, degrees up, times as far), and whether the hands are in it. */
export interface DeskShot {
  view: DeskView;
  orbit?: number;
  tilt?: number;
  distance?: number;
  hands?: boolean;
  /** In "float", whether the iPad floats beside the laptop; without it the laptop is alone in the middle. */
  ipad?: boolean;
}
/** What the desk page draws: a shot, or part of the way between two (the first itself a flight, when one began mid-flight). */
export type DeskState = DeskShot | { from: DeskState; to: DeskState; amount: number };
/** The lid's angle when nothing has moved it, in degrees: 0 is shut. */
export const DESK_LID = 107;
export const DESK_LID_MAX = 135;

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
  // The photographed light (Poly Haven, CC0): the rooms as HDR panoramas, and the desk's oak.
  const studio = /^\/studio\/(loft\.hdr|studio\.hdr|oak_diff\.jpg|oak_nor\.jpg|oak_rough\.jpg)$/.exec(pathname);
  if (studio) {
    const body = readFileSync(new URL(`../assets/studio/${studio[1]}`, import.meta.url));
    return { body, contentType: studio[1].endsWith(".hdr") ? "application/octet-stream" : "image/jpeg" };
  }
  if (pathname === "/macbook.glb") {
    return { body: readFileSync(new URL("../assets/macbook/macbook.glb", import.meta.url)), contentType: "model/gltf-binary" };
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
canvas { display: block; width: 100vw; height: 100vh; }
#label { position: absolute; left: 50%; top: 7%; transform: translateX(-50%); padding: .35em .85em; border-radius: 999px;
  background: rgba(20,20,24,.84); color: #fff; font-size: 18px; font-weight: 600; letter-spacing: .04em; white-space: nowrap;
  opacity: 0; box-shadow: 0 6px 18px rgba(0,0,0,.3); }
</style>
<script type="importmap">{ "imports": { "three": "${DESK_URL}three/build/three.module.js" } }</script>
</head><body><div id="label"></div>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "${DESK_URL}three/examples/jsm/loaders/GLTFLoader.js";
import { HDRLoader } from "${DESK_URL}three/examples/jsm/loaders/HDRLoader.js";
const LAYOUT = ${JSON.stringify(layout(opts.laptop))};
const OPTS = ${JSON.stringify(opts)};
const HANDS_URL = ${JSON.stringify(`${DESK_URL}hands/`)};
const MACBOOK_URL = ${JSON.stringify(`${DESK_URL}macbook.glb`)};
const STUDIO_URL = ${JSON.stringify(`${DESK_URL}studio/`)};
${SCENE}
</script></body></html>`;
  pageCache.set(key, html);
  return html;
}

const SCENE = String.raw`
const U = 1; // one key unit, 19 mm
// The laptop is a model of a 16-inch MacBook Pro (assets/macbook), in decimetres; the scene is in key units.
const MODEL_SCALE = 100 / 19;
// Its body, in key units: the deck's top is y = 0, the feet at BASE_BOTTOM; the hinge is at the back.
const BODY_W = 3.558 * MODEL_SCALE, BODY_D = 2.481 * MODEL_SCALE, BASE_BOTTOM = -0.141 * MODEL_SCALE;
// Key caps as a MacBook's: low, rounded, a little apart, in the well; they go down a touch further than a real key's
// millimetre, so a press shows.
const KEY_H = 0.1, KEY_TRAVEL = 0.07, KEY_GAP = 0.14, KEY_R = 0.13;
const mac = LAYOUT.name === "mac";
const P = mac
  ? { body: 0xc9cacf, bodyEdge: 0xb6b7bc, key: 0x2a2a2d, keySide: 0x1f1f22, legend: "#f2f2f4", bezel: 0x0a0a0b, trackpad: 0xbfc0c5 }
  : { body: 0x2a2b2f, bodyEdge: 0x1c1d20, key: 0xe2e3e7, keySide: 0xc6c7cc, legend: "#1c1c1f", bezel: 0x111214, trackpad: 0x34353a };
const ACCENT = 0x2f7cf6;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
// Drawn at SUPERSAMPLE times the size and shown at the page's: the browser's scaling down averages each pixel's
// samples, on top of the 4x multisampling, so thin edges (key gaps, the bezel, the lid's rim) don't step.
const SUPERSAMPLE = 2;
renderer.setPixelRatio(SUPERSAMPLE);
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// Neutral, as product shots are graded: colours (the aluminium, the skin, black keys) stay what they are, with only
// the brightest highlights rolled off.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.95;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15161a);
const camera = new THREE.PerspectiveCamera(30, OPTS.aspect, 0.1, 400);

// ---------------------------------------------------------------- light: photographed rooms, a key for shadows, and the screen's glow
// Two real rooms, as HDR panoramas (Poly Haven, CC0), light the scene and are what the aluminium, the keys and the
// skin reflect: a daylit loft for the desk, and a photo studio's softboxes for the float view. The desk's room is
// also the backdrop, out of focus, as a camera this close to a laptop sees the room behind it.
const ROOM_TURN = new THREE.Euler(0, 2.3, 0); // the loft's windows to the left, behind
const rooms = {};
{
  const loader = new HDRLoader();
  const pmrem = new THREE.PMREMGenerator(renderer);
  for (const name of ["loft", "studio"]) {
    const hdr = await loader.loadAsync(STUDIO_URL + name + ".hdr");
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    rooms[name] = { picture: hdr, light: pmrem.fromEquirectangular(hdr).texture };
  }
  pmrem.dispose();
}
scene.environment = rooms.loft.light;
scene.environmentRotation.copy(ROOM_TURN);
scene.environmentIntensity = 0.7;
scene.background = rooms.loft.picture;
scene.backgroundRotation.copy(ROOM_TURN);
scene.backgroundBlurriness = 0.1;
scene.backgroundIntensity = 0.55;
// The key: the windows' light, for the shadows a panorama can't cast. Soft, from the upper left.
const key = new THREE.DirectionalLight(0xfff4e8, 1.3);
key.position.set(-22, 30, 12);
key.target.position.set(0, 0, -2);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -26; key.shadow.camera.right = 26;
key.shadow.camera.top = 26; key.shadow.camera.bottom = -26;
key.shadow.camera.near = 5; key.shadow.camera.far = 90;
key.shadow.bias = -0.0003;
key.shadow.normalBias = 0.03;
scene.add(key, key.target);
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
// A table, 1.7 by 0.95 m and 3 cm thick, the laptop toward its front: light oak veneer (Poly Haven, CC0) with its
// grain, sheen and roughness, or a plain colour with a faint grain when the desk's surface is one.
const TABLE = { w: 90, d: 50, t: 1.6, z: -8 };
const deskMat = new THREE.MeshStandardMaterial({ roughness: 0.9, transparent: true });
if (OPTS.surface === "oak") {
  const tex = new THREE.TextureLoader();
  const map = (name, srgb) => {
    const t = tex.load(STUDIO_URL + name);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    // A tile is about 30 cm of veneer; the grain runs along the table.
    t.repeat.set(5.5, 3.1);
    t.center.set(0.5, 0.5);
    t.rotation = Math.PI / 2;
    t.anisotropy = MAX_ANISO;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  deskMat.map = map("oak_diff.jpg", true);
  deskMat.roughnessMap = map("oak_rough.jpg", false);
  deskMat.normalMap = map("oak_nor.jpg", false);
  deskMat.normalScale.set(0.3, 0.3);
  deskMat.roughness = 1;
} else deskMat.map = grain(OPTS.surface);
const desk = new THREE.Mesh(new THREE.BoxGeometry(TABLE.w, TABLE.t, TABLE.d), deskMat);
desk.position.set(0, BASE_BOTTOM - 0.01 - TABLE.t / 2, TABLE.z);
desk.receiveShadow = true;
scene.add(desk);

// ---------------------------------------------------------------- the laptop
const W = LAYOUT.width, D = LAYOUT.height;
// The key block sits in the model's keyboard well: centred across, its middle at the well's.
const KEYS_Z = -0.424 * MODEL_SCALE - (D * U) / 2; // the block's far edge
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
// Everything that is the laptop, so it can be lifted off the desk and turned as one in the float view. Positions
// inside it (the keys, the hands) are the laptop's own, the same as the world's while it sits on the desk.
const laptop = new THREE.Group();
scene.add(laptop);
// The iPad's back, in the laptop's metal.
const bodyMat = new THREE.MeshStandardMaterial({ color: P.body, roughness: 0.45, metalness: mac ? 0.35 : 0.1 });

// The model, its parts baked into key units. The lid's parts (by their materials) go on a hinge at the body's back
// edge, where the model has the lid upright: the lid's angle is then a turn about the hinge from 90°.
const HINGE = new THREE.Vector3(0, -0.065, -1.262).multiplyScalar(MODEL_SCALE);
const LID_MATERIALS = new Set(["Aluminum_-_Satin", "Glass_Clear", "Steel_-_Satin", "Steel_-_Satin_NONE"]);
// The display: a 16-inch MacBook Pro's, 345.6 by 223.4 mm (16:10.3), a thin black border inside the lid's rim, its
// middle 1.24 dm up the lid from the hinge. The lid is stretched (or squashed) up its height to the demo's aspect,
// so the demo fills the display edge to edge as a Mac's own desktop would; past what a lid could pass for, the
// picture fits inside the display instead.
const DISPLAY_W = 3.456, DISPLAY_H = 2.234, DISPLAY_MID = 1.24 + 0.065;
const LID_STRETCH = Math.min(1.35, Math.max(0.75, DISPLAY_W / DISPLAY_H / OPTS.aspect));
const lid = new THREE.Group();
lid.position.copy(HINGE);
// The model's hinge is below the deck, where the open lid's foot is; shut, the lid would sink into the body. So the
// hinge rises as the lid comes past upright, until shut the lid lies on the keys.
const HINGE_LIFT = 0.1 * MODEL_SCALE;
function setLid(degrees) {
  lid.rotation.x = Math.PI / 2 - (degrees * Math.PI) / 180;
  lid.position.y = HINGE.y + HINGE_LIFT * Math.min(1, Math.max(0, (90 - degrees) / 90));
}
setLid(${DESK_LID});
laptop.add(lid);
{
  const model = (await new GLTFLoader().loadAsync(MACBOOK_URL)).scene;
  model.updateMatrixWorld(true);
  const parts = [];
  model.traverse((o) => { if (o.isMesh) parts.push(o); });
  for (const m of parts) {
    const name = m.material.name;
    if (name === "Glass_Clear") continue; // a pale film over the screen, which would wash the demo out
    m.geometry.applyMatrix4(m.matrixWorld);
    m.geometry.scale(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);
    m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.set(1, 1, 1);
    m.castShadow = true;
    m.receiveShadow = true;
    // Satin aluminium: metal, a little rough, reflecting the room. The PC is the same body, dark.
    if (m.material.metalness > 0.2) { m.material.metalness = 0.75; m.material.roughness = 0.42; }
    if (!mac && !name.startsWith("Rubber") && name !== "Steel_-_Satin" && name !== "Steel_-_Satin_NONE") {
      // The PC: a dark, matte body, which stays dark in the studio's light rather than reflecting it as silver.
      m.material.color.setHex(0x2c2e33);
      m.material.metalness = 0.25;
      m.material.roughness = 0.55;
    }
    if (LID_MATERIALS.has(name)) {
      m.geometry.translate(-HINGE.x, -HINGE.y, -HINGE.z);
      m.geometry.scale(1, LID_STRETCH, 1);
      lid.add(m);
    } else laptop.add(m);
  }
}
// From the hinge to the lid's top edge.
const LID_H = (2.393 + 0.065) * MODEL_SCALE * LID_STRETCH;

// Legends, drawn once each into the keycap's top texture, in the bundled Inter: it must have loaded first,
// or the canvas silently draws the default serif (Times). The layout follows the keyboard's own:
// a MacBook's small lowercase words in a bottom corner and its modifiers' symbols in the opposite top
// corner; a PC's words top-left.
await Promise.all(["400", "500"].map((w) => document.fonts.load(w + " 32px Inter")));
const FONT = (weight, size) => weight + " " + size + "px Inter, system-ui, sans-serif";
const MAC_LEFT_MODS = new Set(["Fn", "ControlLeft", "AltLeft", "MetaLeft"]);
const MAC_RIGHT_MODS = new Set(["MetaRight", "AltRight"]);
const WORD_LEFT = new Set(["Tab", "CapsLock", "ShiftLeft", "Escape", "ControlLeft"]);
const WORD_RIGHT = new Set(["Backspace", "Enter", "ShiftRight", "Delete", "ControlRight"]);
// The globe on a MacBook's fn key, drawn as lines: an emoji would depend on the host's emoji font.
function globe(g, cx, cy, r) {
  g.save();
  g.lineWidth = Math.max(1.2, r * 0.13);
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.ellipse(cx, cy, r * 0.45, r, 0, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(cx - r, cy); g.lineTo(cx + r, cy); g.stroke();
  g.restore();
}
const legendCache = new Map();
function legendTexture(cap, accent) {
  const k = cap.id + ":" + accent;
  if (legendCache.has(k)) return legendCache.get(k);
  const px = 128; // pixels per key unit
  const c = document.createElement("canvas");
  c.width = Math.round(px * cap.w); c.height = Math.round(px * cap.h);
  const g = c.getContext("2d");
  g.fillStyle = accent ? "#2f7cf6" : "#" + P.key.toString(16).padStart(6, "0");
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = g.strokeStyle = accent ? "#ffffff" : P.legend;
  const W = c.width, H = c.height, pad = px * 0.12;
  const word = (text, align, baseline, x, y, size) => {
    g.font = FONT(400, size); g.textAlign = align; g.textBaseline = baseline; g.fillText(text, x, y);
  };
  const isWordKey = (cap.legend.length > 2 || cap.id === "Fn") && !/^F\d+$/.test(cap.legend);
  if (cap.id === "Fn" && mac) {
    globe(g, pad + px * 0.1, H - pad - px * 0.1, px * 0.09);
    word("fn", "right", "top", W - pad, pad, px * 0.15);
  } else if (mac && (MAC_LEFT_MODS.has(cap.id) || MAC_RIGHT_MODS.has(cap.id))) {
    const left = MAC_LEFT_MODS.has(cap.id);
    word(cap.legend, left ? "right" : "left", "top", left ? W - pad : pad, pad - px * 0.02, px * 0.2);
    if (cap.sub) word(cap.sub, left ? "left" : "right", "bottom", left ? pad : W - pad, H - pad, px * 0.13);
  } else if (cap.shifted) {
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = FONT(400, px * 0.2); g.fillText(cap.shifted, W / 2, H * 0.32);
    g.font = FONT(400, px * 0.2); g.fillText(cap.legend, W / 2, H * 0.68);
  } else if (/^F\d+$/.test(cap.legend) || (cap.id === "Escape" && mac)) {
    word(cap.legend, mac && cap.id === "Escape" ? "left" : "center", mac && cap.id === "Escape" ? "bottom" : "middle",
      mac && cap.id === "Escape" ? pad : W / 2, mac && cap.id === "Escape" ? H - pad * 0.6 : H / 2, px * 0.15);
  } else if (isWordKey) {
    const right = WORD_RIGHT.has(cap.id);
    if (mac) word(cap.legend, right ? "right" : "left", "bottom", right ? W - pad : pad, H - pad, px * 0.14);
    else word(cap.legend, "left", "top", pad, pad, px * 0.15);
  } else if (cap.legend) {
    g.textAlign = "center"; g.textBaseline = "middle";
    const arrow = /^[▲▼◀▶]$/.test(cap.legend);
    g.font = FONT(400, px * (arrow ? 0.14 : 0.26));
    g.fillText(cap.legend, W / 2, H / 2 + px * 0.01);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = MAX_ANISO;
  legendCache.set(k, tex);
  return tex;
}
const keys = new Map();
// A cap's shape: a rounded rectangle, raised, its top's texture across the whole cap. One per size.
const capGeos = new Map();
function capGeometry(w, d) {
  const k = w.toFixed(3) + "x" + d.toFixed(3);
  if (capGeos.has(k)) return capGeos.get(k);
  const geo = new THREE.ExtrudeGeometry(roundedRect(w, d, Math.min(KEY_R, w / 3, d / 3)), {
    depth: KEY_H - 0.03, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 2, curveSegments: 6,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0.03, 0);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / w + 0.5, 0.5 - pos.getZ(i) / d);
  capGeos.set(k, geo);
  return geo;
}
for (const cap of LAYOUT.keys) {
  const w = cap.w * U - KEY_GAP, d = cap.h * U - KEY_GAP;
  const matSide = new THREE.MeshStandardMaterial({ color: P.keySide, roughness: 0.8, envMapIntensity: 0.45 });
  // Matte black, with a faint sheen: the room shows in a key only at a glance.
  const matTop = new THREE.MeshStandardMaterial({ map: legendTexture(cap, false), roughness: 0.72, envMapIntensity: 0.45 });
  const matLit = new THREE.MeshStandardMaterial({ map: legendTexture(cap, true), roughness: 0.55, emissive: ACCENT, emissiveIntensity: 0.3 });
  // ExtrudeGeometry's groups: 0 the faces (the top, and the bottom no one sees), 1 the sides.
  const mesh = new THREE.Mesh(capGeometry(w, d), [matTop, matSide]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(ux(cap.x + cap.w / 2), 0, keyZ(cap.y + cap.h / 2));
  laptop.add(mesh);
  keys.set(cap.id, { mesh, cap, matTop, matLit });
}
function keyCenter(id) {
  const k = keys.get(id);
  return new THREE.Vector3(ux(k.cap.x + k.cap.w / 2), KEY_H, keyZ(k.cap.y + k.cap.h / 2));
}

// The screen: the model's display area on the lid (in decimetres, the lid upright), and the demo's picture in it at
// the demo's own aspect, as large as fits, the panel's black round it where the shapes differ.
const DISPLAY = { w: DISPLAY_W * MODEL_SCALE, h: DISPLAY_H * MODEL_SCALE * LID_STRETCH, y: DISPLAY_MID * MODEL_SCALE * LID_STRETCH, z: 0.006 * MODEL_SCALE };
const SCREEN_W = Math.min(DISPLAY.w, DISPLAY.h * OPTS.aspect);
const SCREEN_H = SCREEN_W / OPTS.aspect;
const screenTex = new THREE.Texture();
screenTex.colorSpace = THREE.SRGBColorSpace;
// Mipmapped and anisotropic: the demo's text stays legible when the screen is small or seen at an angle, where a
// plain linear filter skips texels and the text breaks up.
screenTex.minFilter = THREE.LinearMipmapLinearFilter;
screenTex.anisotropy = MAX_ANISO;
screenTex.magFilter = THREE.LinearFilter;
screenTex.generateMipmaps = true;
const screenMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H), screenMat);
screen.position.set(0, DISPLAY.y, DISPLAY.z);
lid.add(screen);
// The display's own shape, as on the real one: its top corners rounded, and the camera's notch in the middle of the top
// edge, its bottom corners rounded and its sides curving out into the edge. Drawn as black over the picture's square
// corners, and faded in as the view leaves the flat frame, which is the desktop exactly and has none of it.
const notchMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, toneMapped: false });
const displayMask = (() => {
  const mm = MODEL_SCALE / 100; // a millimetre, in key units
  const L = -SCREEN_W / 2, R = SCREEN_W / 2, T = SCREEN_H / 2, over = 0.6 * mm; // a little past the edge, onto the bezel
  const corner = 7 * mm, notchW = 31 * mm, notchH = 6 * mm, bottomR = 2 * mm, shoulder = 1.2 * mm;
  const shapes = [];
  // The corners: the square corner, less a quarter circle.
  for (const side of [-1, 1]) {
    const s = new THREE.Shape(), x = side < 0 ? L : R, cx = x - side * corner, cy = T - corner;
    s.moveTo(x + side * over, T + over);
    s.lineTo(x + side * over, cy);
    s.lineTo(x, cy);
    s.absarc(cx, cy, corner, side < 0 ? Math.PI : 0, Math.PI / 2, side < 0);
    s.lineTo(cx, T + over);
    shapes.push(s);
  }
  // The notch, from its left shoulder round to its right: a MacBook's; the PC has none.
  if (!mac) return new THREE.Mesh(new THREE.ShapeGeometry(shapes, 24), notchMat);
  const n = new THREE.Shape(), a = notchW / 2;
  n.moveTo(-a - shoulder, T + over);
  n.lineTo(-a - shoulder, T);
  n.absarc(-a - shoulder, T - shoulder, shoulder, Math.PI / 2, 0, true);
  n.lineTo(-a, T - notchH + bottomR);
  n.absarc(-a + bottomR, T - notchH + bottomR, bottomR, Math.PI, Math.PI * 1.5, false);
  n.lineTo(a - bottomR, T - notchH);
  n.absarc(a - bottomR, T - notchH + bottomR, bottomR, Math.PI * 1.5, Math.PI * 2, false);
  n.lineTo(a, T - shoulder);
  n.absarc(a + shoulder, T - shoulder, shoulder, Math.PI, Math.PI / 2, true);
  n.lineTo(a + shoulder, T + over);
  shapes.push(n);
  return new THREE.Mesh(new THREE.ShapeGeometry(shapes, 24), notchMat);
})();
displayMask.position.set(0, DISPLAY.y, DISPLAY.z + 0.004);
lid.add(displayMask);
// The display's glass: a faint reflection of the room over the picture, as every photo of a screen has. Faded in
// with the shape above, off in the flat frame.
const glassMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.45, transparent: true, opacity: 0, depthWrite: false });
const glass = new THREE.Mesh(new THREE.PlaneGeometry(DISPLAY.w, DISPLAY.h), glassMat);
glass.position.set(0, DISPLAY.y, DISPLAY.z + 0.008);
lid.add(glass);

// ---------------------------------------------------------------- the studio: the float view's stage
// A void in the backdrop colour, lighter above and deeper below, with the devices' shadows soft on a floor
// far beneath them. It fades in over the room as the desk fades out.
const BACKDROP = new THREE.Color(OPTS.backdrop);
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(320, 48, 24),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, transparent: true,
    uniforms: {
      top: { value: BACKDROP.clone().lerp(new THREE.Color(0xffffff), 0.35) },
      bottom: { value: BACKDROP.clone().multiplyScalar(0.55) },
      opacity: { value: 0 },
    },
    vertexShader: "varying vec3 p; void main() { p = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "uniform vec3 top; uniform vec3 bottom; uniform float opacity; varying vec3 p; void main() { gl_FragColor = vec4(mix(bottom, top, smoothstep(-0.45, 0.55, p.y)), opacity);\n#include <colorspace_fragment>\n}",
  }),
);
sky.renderOrder = -1;
scene.add(sky);
// A soft shadow under each device, as in a product shot: a blurred ellipse on a floor far below, not the key light's
// hard shadow, which would show the floor's edge.
const blobTex = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, "rgba(0,0,0,1)");
  r.addColorStop(0.45, "rgba(0,0,0,0.55)");
  r.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
})();
function blob(w, d) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: blobTex, color: BACKDROP.clone().multiplyScalar(0.25), transparent: true, opacity: 0, depthWrite: false, fog: false }));
  m.rotation.x = -Math.PI / 2;
  m.visible = false;
  scene.add(m);
  return m;
}
const FLOOR_Y = -14;
const shadows = { laptop: blob(36, 30), ipad: blob(24, 18) };

// The iPad, landscape: an 11-inch iPad Pro in key units (19 mm), the laptop's metal on the back, black glass on the
// front, and the same picture as the laptop's screen, cut to its own shape.
const IPAD_W = 13.4, IPAD_H = 9.6, IPAD_T = 0.33, IPAD_BEZEL = 0.5;
const ipad = new THREE.Group();
ipad.visible = false;
scene.add(ipad);
{
  const shell = new THREE.ExtrudeGeometry(roundedRect(IPAD_W, IPAD_H, 0.95), { depth: IPAD_T, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 3, curveSegments: 16 });
  shell.translate(0, 0, -IPAD_T - 0.05);
  const back = new THREE.Mesh(shell, bodyMat);
  back.castShadow = true;
  ipad.add(back);
  const glass = new THREE.Mesh(new THREE.ShapeGeometry(roundedRect(IPAD_W - 0.04, IPAD_H - 0.04, 0.92), 16), new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.12, metalness: 0.2 }));
  glass.position.z = 0.012;
  ipad.add(glass);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.07, 16), new THREE.MeshStandardMaterial({ color: 0x1b1d24, roughness: 0.2 }));
  lens.position.set(0, IPAD_H / 2 - IPAD_BEZEL / 2, 0.016);
  ipad.add(lens);
}
const IPAD_SW = IPAD_W - IPAD_BEZEL * 2, IPAD_SH = IPAD_H - IPAD_BEZEL * 2;
const ipadTex = new THREE.Texture();
ipadTex.colorSpace = THREE.SRGBColorSpace;
ipadTex.minFilter = THREE.LinearMipmapLinearFilter;
ipadTex.anisotropy = MAX_ANISO;
ipadTex.generateMipmaps = true;
// The demo's picture, cut to the iPad's screen from the middle: as much as fills it, nothing stretched.
{
  const img = OPTS.aspect, scr = IPAD_SW / IPAD_SH;
  if (img > scr) { ipadTex.repeat.set(scr / img, 1); ipadTex.offset.set((1 - scr / img) / 2, 0); }
  else { ipadTex.repeat.set(1, img / scr); ipadTex.offset.set(0, (1 - img / scr) / 2); }
}
const ipadScreenMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
const ipadScreen = new THREE.Mesh(new THREE.ShapeGeometry(roundedRect(IPAD_SW, IPAD_SH, 0.45), 12), ipadScreenMat);
{
  // ShapeGeometry's UVs are its coordinates; make them 0..1 across the screen.
  const uv = ipadScreen.geometry.attributes.uv, pos = ipadScreen.geometry.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / IPAD_SW + 0.5, pos.getY(i) / IPAD_SH + 0.5);
}
ipadScreen.position.z = 0.02;
ipad.add(ipadScreen);

// Where each device floats, and how it turns: the laptop to the left, three-quarters on; the iPad in front of it
// to the right, tipped back. Each drifts a little, slowly, out of step with the other.
const FLOAT = {
  laptop: { pos: new THREE.Vector3(-4.5, 3.5, -4), rot: new THREE.Euler(0.12, 0.42, 0.04, "YXZ") },
  ipad: { pos: new THREE.Vector3(11.5, 1.5, 6), rot: new THREE.Euler(-0.3, -0.42, -0.06, "YXZ") },
  // Where the iPad comes from as the stage changes: below and in front, out of the shot.
  ipadFrom: new THREE.Vector3(16, -14, 16),
  // The laptop alone: in the middle, where the camera turns round it.
  solo: new THREE.Vector3(0, 3, -1),
};
// What the float view looks at: between the two devices, or the laptop alone (its middle, the lid up).
// The middle of the laptop as it stands, in its own space: halfway from the front of the body to the top of the lid,
// wherever the lid is.
function laptopMiddle() {
  const a = lid.rotation.x;
  const topY = lid.position.y + LID_H * Math.cos(a), topZ = lid.position.z + LID_H * Math.sin(a);
  const yMin = BASE_BOTTOM, yMax = Math.max(topY, KEY_H);
  const zMin = Math.min(-BODY_D / 2, topZ), zMax = BODY_D / 2;
  return new THREE.Vector3(0, (yMin + yMax) / 2, (zMin + zMax) / 2);
}
function floatTarget(ipadAmount) {
  const solo = FLOAT.solo.clone().add(laptopMiddle().applyEuler(FLOAT.laptop.rot));
  return solo.lerp(new THREE.Vector3(2.5, 2.5, 0), ipadAmount);
}
let floatIpad = 1; // how far the iPad is in the float view, for its camera
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qi = new THREE.Quaternion();
// Set the stage at t: 0 is the desk, 1 the studio, with the devices in between.
function setStage(stage, ipadAmount, t) {
  const e = ease(stage);
  floatIpad = ipadAmount;
  const drift = (period, phase, size) => Math.sin(((t / period) + phase) * Math.PI * 2) * size * e;
  laptop.position.copy(FLOAT.solo).lerp(FLOAT.laptop.pos, ipadAmount).multiplyScalar(e);
  laptop.position.y += drift(6400, 0, 0.35);
  _qa.setFromEuler(FLOAT.laptop.rot);
  laptop.quaternion.identity().slerp(_qa, e);
  laptop.rotateY(drift(9000, 0.3, 0.02));
  // The iPad arrives in the second half of the change, so it doesn't cross the laptop on the way.
  const ie = ease(Math.min(1, Math.max(0, Math.min(stage, ipadAmount) * 1.6 - 0.6)));
  ipad.visible = ie > 0.001;
  ipad.position.lerpVectors(FLOAT.ipadFrom, FLOAT.ipad.pos, ie);
  ipad.position.y += drift(5200, 0.45, 0.3);
  _qb.setFromEuler(FLOAT.ipad.rot);
  _qi.setFromEuler(new THREE.Euler(-1.1, -0.9, 0, "YXZ"));
  ipad.quaternion.copy(_qi).slerp(_qb, ie);
  ipad.rotateX(drift(7600, 0.1, 0.015));
  desk.visible = stage < 0.999;
  desk.material.opacity = 1 - e;
  desk.material.depthWrite = e === 0; // fading, it mustn't hide the shadows on the floor below it
  sky.visible = stage > 0.001;
  sky.material.uniforms.opacity.value = e;
  // Each shadow under its device, fainter the higher it drifts.
  for (const [name, obj] of [["laptop", laptop], ["ipad", ipad]]) {
    const sh = shadows[name];
    sh.visible = stage > 0.001;
    sh.position.set(obj.position.x, FLOOR_Y, obj.position.z);
    sh.material.opacity = 0.32 * e * (name === "ipad" ? ie : 1);
  }
  // The studio's softboxes light the float view; the loft, the desk. They change places halfway, mid-flight.
  scene.environment = stage < 0.5 ? rooms.loft.light : rooms.studio.light;
}

// ---------------------------------------------------------------- hands: the model's joints are set one by one, from its rest pose
// Skin that reads warm and soft rather than waxy: a peach base, a reddish sheen where light grazes it,
// and a warm floor so it never goes grey in shadow (the room light is cool).
const skin = new THREE.MeshPhysicalMaterial({
  color: new THREE.Color(OPTS.handColor), roughness: 0.55, metalness: 0,
  sheen: 0.6, sheenColor: new THREE.Color("#ff9a7a"), sheenRoughness: 0.6,
  emissive: new THREE.Color("#5a2a1a"), emissiveIntensity: 0.22,
});
const knit = new THREE.MeshStandardMaterial({ color: new THREE.Color(OPTS.sleeve), roughness: 0.92 });
const MODEL_TO_WORLD = {
  right: new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)),
  left: new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)),
};
const HAND_SCALE = (1 / 0.019) * 0.8; // metres to key units, under life size so the keys show
const PALM_NORMALS = { right: new THREE.Vector3(-1, 0, 0), left: new THREE.Vector3(1, 0, 0) };
const CHAINS = [
  ["thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
  ["index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip"],
  ["middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip"],
  ["ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip"],
  ["pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip"],
];
const REST_CURL = [0.45, 0.42, 0.4, 0.42, 0.48];
// The hands lie a little thumb side up and wrists low, as hands on a laptop do; not flat like paddles.
// The sleeve's cuff: its radius, and where it starts along the forearm from the wrist bone (negative: over the hand), in m.
const SLEEVE_CUFF = 0.034, SLEEVE_AT = -0.012;
const ATTITUDE = { pitch: 0.15, roll: 0.18, yaw: 0.12 };
// Fingertips rest on the keys; a finger about to press lifts this much above its key first.
const REST_H = 0.1, LIFT = 0.35;
const hands = {};

// One level of Phong tessellation (Boubekeur & Alexa 2008) on a skinned, indexed geometry: each triangle
// becomes four, with edge midpoints pulled toward the vertices' tangent planes, so the outline rounds.
function phongSubdivide(geo, alpha = 0.75) {
  const P = geo.attributes.position, N = geo.attributes.normal, UV = geo.attributes.uv;
  const SI = geo.attributes.skinIndex, SW = geo.attributes.skinWeight, idx = geo.index.array;
  const n0 = P.count;
  // Smooth normals across UV seams (the same point, under different indices).
  const key = (i) => P.getX(i).toFixed(5) + "," + P.getY(i).toFixed(5) + "," + P.getZ(i).toFixed(5);
  const acc = new Map();
  for (let i = 0; i < n0; i++) {
    const a = acc.get(key(i)) ?? [0, 0, 0];
    a[0] += N.getX(i); a[1] += N.getY(i); a[2] += N.getZ(i);
    acc.set(key(i), a);
  }
  const pos = [], nor = [], uv = [], si = [], sw = [];
  for (let i = 0; i < n0; i++) {
    const a = acc.get(key(i)), l = Math.hypot(a[0], a[1], a[2]) || 1;
    pos.push(P.getX(i), P.getY(i), P.getZ(i));
    nor.push(a[0] / l, a[1] / l, a[2] / l);
    uv.push(UV ? UV.getX(i) : 0, UV ? UV.getY(i) : 0);
    si.push(SI.getX(i), SI.getY(i), SI.getZ(i), SI.getW(i));
    sw.push(SW.getX(i), SW.getY(i), SW.getZ(i), SW.getW(i));
  }
  const mids = new Map();
  let n = n0;
  const mid = (a, b) => {
    const k = a < b ? a + "_" + b : b + "_" + a;
    if (mids.has(k)) return mids.get(k);
    const m = [0, 1, 2].map((c) => (pos[a * 3 + c] + pos[b * 3 + c]) / 2);
    const proj = (v) => {
      const d = [0, 1, 2].reduce((t, c) => t + (m[c] - pos[v * 3 + c]) * nor[v * 3 + c], 0);
      return m.map((x, c) => x - d * nor[v * 3 + c]);
    };
    const qa = proj(a), qb = proj(b);
    for (let c = 0; c < 3; c++) pos.push((1 - alpha) * m[c] + (alpha * (qa[c] + qb[c])) / 2);
    const nm = [0, 1, 2].map((c) => nor[a * 3 + c] + nor[b * 3 + c]), l = Math.hypot(nm[0], nm[1], nm[2]) || 1;
    nor.push(nm[0] / l, nm[1] / l, nm[2] / l);
    uv.push((uv[a * 2] + uv[b * 2]) / 2, (uv[a * 2 + 1] + uv[b * 2 + 1]) / 2);
    // Skin weights: the two ends' blended, the four strongest kept.
    const w = new Map();
    for (const v of [a, b]) for (let c = 0; c < 4; c++) {
      const j = si[v * 4 + c], ww = sw[v * 4 + c] * 0.5;
      if (ww > 0) w.set(j, (w.get(j) ?? 0) + ww);
    }
    const top = [...w.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 4);
    const total = top.reduce((t, e) => t + e[1], 0) || 1;
    for (let c = 0; c < 4; c++) { si.push(top[c] ? top[c][0] : 0); sw.push(top[c] ? top[c][1] / total : 0); }
    mids.set(k, n);
    return n++;
  };
  const out = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(out);
  return g;
}

async function loadHand(side) {
  const gltf = await new GLTFLoader().loadAsync(HANDS_URL + side + ".glb");
  const model = gltf.scene;
  const bones = {};
  model.traverse((o) => {
    if (o.isBone) bones[o.name] = o;
    if (o.isMesh) {
      // The model is low-poly (~1,400 vertices): rounded once at load, its fingertips stop reading as faceted claws.
      if (o.isSkinnedMesh) o.geometry = phongSubdivide(phongSubdivide(o.geometry));
      o.material = skin; o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
    }
  });
  const chains = CHAINS.map((names) => {
    const joints = names.map((n) => ({ bone: bones[n], restPos: bones[n].position.clone(), restQuat: bones[n].quaternion.clone() }));
    const dir = joints[joints.length - 1].restPos.clone().sub(joints[1].restPos).normalize();
    return { joints, dir, lateral: dir.clone().cross(PALM_NORMALS[side]).normalize() };
  });
  const root = new THREE.Group();
  const s = side === "right" ? 1 : -1;
  root.quaternion
    .setFromEuler(new THREE.Euler(ATTITUDE.pitch, s * ATTITUDE.yaw, -s * ATTITUDE.roll, "YXZ"))
    .multiply(new THREE.Quaternion().setFromRotationMatrix(MODEL_TO_WORLD[side]));
  root.scale.setScalar(HAND_SCALE);
  root.add(model);
  const holder = new THREE.Group(); // positioned; the root inside carries the model's orientation
  holder.add(root);
  laptop.add(holder);
  holder.updateMatrixWorld(true);
  // The forearm, which the model stops short of: a knit sleeve whose cuff swallows the wrist's open end, angled
  // down and out toward a body in front of the laptop. The sleeve says "a person"; bare tubes the colour of the
  // hands read as stumps, and any skin between hand and cuff shows the join.
  const wrist = bones["wrist"].position.clone();
  const toBody = new THREE.Vector3(s * 0.3, -0.14, 1).normalize().applyQuaternion(model.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
  const cuff = SLEEVE_CUFF, len = 0.32;
  const profile = [[0, 0], [cuff - 0.004, 0], [cuff, 0.004], [cuff + 0.001, 0.012], [cuff, 0.02], [cuff + 0.002, 0.03], [0.041, len * 0.6], [0.045, len], [0, len]];
  const sleeve = new THREE.Mesh(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 40), knit);
  sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), toBody);
  sleeve.position.copy(wrist).addScaledVector(toBody, SLEEVE_AT);
  sleeve.castShadow = true;
  sleeve.receiveShadow = true;
  model.add(sleeve);
  hands[side] = { side, sign: s, root: holder, chains, palm: PALM_NORMALS[side], memo: [] };
}

const _q = new THREE.Quaternion(), _axis = new THREE.Vector3(), _v = new THREE.Vector3();
// Curl a finger's joints from the knuckle in, with a press that straightens it a little and dips it from the knuckle, and a sideways spread.
function poseFinger(hand, f, curl, press, spread = 0) {
  const chain = hand.chains[f];
  const thumb = f === 0;
  const c = curl * (1 - press * 0.4);
  const angles = thumb
    ? [0.25, 0.25 + press * 0.3, 0.3 + c * 0.7, 0]
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
      _axis.copy(hand.palm).applyQuaternion(A);
      _q.setFromAxisAngle(_axis, spread);
      A.premultiply(_q);
    }
    j.bone.position.copy(prevNew);
    j.bone.quaternion.copy(A).multiply(j.restQuat);
  }
}
// A fingertip, in the laptop's space (the keys'), wherever the laptop is.
function tipAt(hand, f) {
  hand.root.updateMatrixWorld(true);
  const chain = hand.chains[f];
  return laptop.worldToLocal(chain.joints[chain.joints.length - 1].bone.getWorldPosition(_v.clone()));
}
function placeHandFor(hand, f, target) {
  hand.root.position.set(0, 0, 0);
  const tip = tipAt(hand, f);
  hand.root.position.set(target.x - tip.x, target.y - tip.y, target.z - tip.z);
}
// Aim another finger of a placed hand at a key, by spreading at the knuckle and curling to reach.
function aimFinger(hand, f, target, press) {
  let best = null;
  const wide = f === 0 ? 1.4 : 0.7; // a thumb swings further than a finger spreads
  for (let spread = -wide; spread <= wide + 1e-9; spread += wide / 5) {
    for (let curl = 0.05; curl <= 1.25; curl += 0.1) {
      poseFinger(hand, f, curl, press, spread);
      const tip = tipAt(hand, f);
      const err = (tip.x - target.x) ** 2 + (tip.z - target.z) ** 2 + 0.35 * (tip.y - target.y) ** 2;
      if (!best || err < best.err) best = { err, curl, spread };
    }
  }
  // The grid's best, refined: a target that moves a little moves the finger a little, not a grid step.
  const errAt = (curl, spread) => {
    poseFinger(hand, f, curl, press, spread);
    const tip = tipAt(hand, f);
    return (tip.x - target.x) ** 2 + (tip.z - target.z) ** 2 + 0.35 * (tip.y - target.y) ** 2;
  };
  for (let step = 0.05; step > 0.002; step /= 2) {
    for (const [dc, ds] of [[step, 0], [-step, 0], [0, step * 1.4], [0, -step * 1.4]]) {
      const curl = Math.min(1.3, Math.max(0, best.curl + dc)), spread = Math.min(wide, Math.max(-wide, best.spread + ds));
      const err = errAt(curl, spread);
      if (err < best.err) best = { err, curl, spread };
    }
  }
  poseFinger(hand, f, best.curl, press, best.spread);
  return best;
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
// Each hand has a home over its home row, fingers resting on a s d f / j k l ; and its thumb by the space bar.
// The hand goes where its fingers can reach the keys it presses; the fingers do the last of it. Where the hand is and where each finger points are smooth functions of time through
// the key events, so nothing jumps between frames, however fast the typing.
const HOME_KEYS = { left: [null, "f", "d", "s", "a"], right: [null, "j", "k", "l", "Semicolon"] };
const APPROACH = 150, REACH_MIN = 90, SETTLE = 450, HOME_AFTER = 700;
const homeRoot = {};

// Where a finger rests: over its home key, the thumb over the space bar, moving with the hand.
function homeTarget(hand, f) {
  let c;
  if (f) c = keyPoint(hand, { id: HOME_KEYS[hand.side][f], finger: f });
  else {
    // The thumb: on the space bar, a little inside the index finger.
    c = keyCenter("Space");
    c.x = keyCenter(HOME_KEYS[hand.side][1]).x - hand.sign * 0.6 * U;
  }
  c.y += REST_H;
  return c.add(hand.root.position).sub(homeRoot[hand.side]);
}
function placeHome(hand) {
  for (let f = 0; f < 5; f++) poseFinger(hand, f, REST_CURL[f], 0);
  const c = keyCenter(HOME_KEYS[hand.side][1]);
  placeHandFor(hand, 1, new THREE.Vector3(c.x, c.y + REST_H + 0.15, c.z));
  const root = hand.root.position.clone();
  homeRoot[hand.side] = root;
  // Where each fingertip is, from the hand, as it presses in its resting curl: what the hand is placed by.
  hand.reach = [0, 1, 2, 3, 4].map((f) => {
    poseFinger(hand, f, REST_CURL[f], 1);
    const tip = tipAt(hand, f).sub(root);
    poseFinger(hand, f, REST_CURL[f], 0);
    return tip;
  });
}
// Where on a key a finger presses: its centre, or on a wide key (the space bar, shift) the point nearest where the
// finger is at home, so a thumb takes the space bar where it lies.
function keyPoint(hand, k) {
  const { cap } = keys.get(k.id);
  const c = keyCenter(k.id);
  if (!hand.reach) return c;
  const half = Math.max(0, ux(cap.x + cap.w) - c.x - 0.45);
  const x = homeRoot[hand.side].x + hand.reach[k.finger].x;
  c.x = Math.min(c.x + half, Math.max(c.x - half, x));
  return c;
}
// How far the hand shifts for an event: to where its fingers, pressing in their resting curl, are over their keys,
// less the SLACK that the fingers themselves reach.
const SLACK = 0.45;
function shiftFor(hand, keys) {
  const sum = new THREE.Vector3();
  for (const k of keys) sum.add(keyPoint(hand, k).sub(hand.reach[k.finger]).sub(homeRoot[hand.side]));
  sum.multiplyScalar(1 / keys.length).y = 0;
  const len = sum.length();
  return len > SLACK ? sum.multiplyScalar((len - SLACK) / len) : sum.set(0, 0, 0);
}
// The hand's own events, as windows: from when it may start toward them to when they let go.
function windowsFor(side) {
  const out = [];
  for (const ev of events) {
    const keys = ev.keys.filter((k) => k.hand === side);
    if (!keys.length) continue;
    const down = ev.at - (keys.some((k) => k.modifier) ? MOD_LEAD : 0);
    const up = ev.at + ev.hold + (keys.some((k) => k.modifier) ? MOD_TAIL : 0);
    out.push({ ev, keys, down, up, from: ev.from ?? -Infinity });
  }
  return out;
}
// How far each of the hand's events has drawn it, at t: rising as the hand approaches, held, then giving way to
// any later event as that one rises, and fading home once the hand has been idle a while. Every weight is a
// continuous function of t, so blends of them are too, however the events overlap.
function riseOf(w, t) {
  const start = Math.max(w.down - APPROACH, w.from);
  const at = Math.max(start + REACH_MIN, w.down - 30);
  return ease((t - start) / (at - start));
}
function weightsAt(wins, t) {
  return wins.map((w, i) => {
    let b = riseOf(w, t) * (1 - ease((t - (w.up + HOME_AFTER)) / SETTLE));
    for (let j = i + 1; j < wins.length && b > 0; j++) if (wins[j].down > w.down) b *= 1 - riseOf(wins[j], t);
    return b;
  });
}
// Where the hand is at t, as an offset from home, and how high it lifts to travel.
function offsetAt(hand, wins, t) {
  const weights = weightsAt(wins, t);
  const shift = new THREE.Vector3();
  let total = 0, lift = 0, prev = new THREE.Vector3();
  wins.forEach((w, i) => {
    const s = shiftFor(hand, w.keys);
    const travel = s.distanceTo(prev);
    prev = s;
    if (!weights[i]) return;
    shift.addScaledVector(s, weights[i]);
    total += weights[i];
    if (travel > 0.6) lift = Math.max(lift, Math.sin(riseOf(w, t) * Math.PI) * Math.min(0.4, travel * 0.15));
  });
  return { shift: shift.multiplyScalar(1 / Math.max(1, total)), lift };
}
// How much a finger is drawn toward a key of an event at t: rising as it approaches, held, falling after.
function pull(w, k, t) {
  const down = k.modifier ? w.ev.at - MOD_LEAD : w.ev.at;
  const up = k.modifier ? w.ev.at + w.ev.hold + MOD_TAIL : w.ev.at + w.ev.hold;
  const start = Math.max(down - APPROACH, w.from);
  // A finger takes at least REACH_MIN to get there, even when its key comes sooner than that; it arrives late.
  const there = Math.max(down, start + REACH_MIN), leaves = Math.max(up, there);
  if (t <= start || t >= leaves + 120) return 0;
  if (t < there) return ease((t - start) / (there - start));
  return t <= leaves ? 1 : 1 - ease((t - leaves) / 120);
}
function placeHand(hand, t) {
  const wins = windowsFor(hand.side);
  for (let f = 0; f < 5; f++) poseFinger(hand, f, REST_CURL[f], 0);
  const { shift, lift } = offsetAt(hand, wins, t);
  hand.root.position.copy(homeRoot[hand.side]).add(shift);
  hand.root.position.y += lift;
  // Each finger: toward the keys pulling it, blended by how hard each pulls, else where it rests.
  for (let f = 0; f < 5; f++) {
    let total = 0, press = 0;
    const toward = new THREE.Vector3();
    for (const w of wins) for (const k of w.keys) {
      if (k.finger !== f) continue;
      const amount = pull(w, k, t);
      if (!amount) continue;
      const p = pressAmount(w.ev, k, t);
      const c = keyPoint(hand, k);
      toward.addScaledVector(new THREE.Vector3(c.x, c.y + REST_H + LIFT * (1 - p) - 0.12 * p, c.z), amount);
      press += p * amount;
      total += amount;
    }
    const home = homeTarget(hand, f);
    const from = home;
    const norm = Math.max(1, total);
    const target = from.clone().multiplyScalar(1 - Math.min(1, total)).addScaledVector(toward, Math.min(1, total) / total || 0);
    press /= norm;
    // A finger whose target and press haven't moved keeps last frame's pose rather than searching again.
    const memoKey = target.x.toFixed(3) + "," + target.y.toFixed(3) + "," + target.z.toFixed(3) + "," + press.toFixed(3) + "," +
      hand.root.position.x.toFixed(3) + "," + hand.root.position.y.toFixed(3) + "," + hand.root.position.z.toFixed(3);
    const m = hand.memo[f];
    if (m && m.key === memoKey) { poseFinger(hand, f, m.curl, press, m.spread); continue; }
    const got = aimFinger(hand, f, target, press);
    hand.memo[f] = { key: memoKey, curl: got.curl, spread: got.spread };
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
    return { pos: new THREE.Vector3(-4.5, 21.5, 30), at: new THREE.Vector3(0, 4.6, -3), up: new THREE.Vector3(0, 1, 0), fov: 30 };
  }
  if (name === "side") return { pos: new THREE.Vector3(34, 5, 2), at: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 1, 0), fov: 28 };
  if (name === "float") {
    // Alone, the laptop is framed closer.
    const at = floatTarget(floatIpad);
    const pos = at.clone().add(new THREE.Vector3(2.5, 10.5, 58).multiplyScalar(0.8 + 0.3 * floatIpad));
    return { pos, at, up: new THREE.Vector3(0, 1, 0), fov: 30 };
  }
  // keyboard: over the hands, keys filling the width, the screen's foot above
  return { pos: new THREE.Vector3(0, 19.5, 10.7), at: new THREE.Vector3(0, 0.3, -2.4), up: new THREE.Vector3(0, 1, 0), fov: 32 };
}
// A shot's pose: its view's, with the camera moved around what it looks at: orbit degrees around (to the right),
// tilt degrees up, and distance times as far.
const Y = new THREE.Vector3(0, 1, 0);
function shotPose(shot) {
  const p = viewPose(shot.view);
  if (shot.view === "flat") return p;
  const off = p.pos.clone().sub(p.at);
  if (shot.orbit) off.applyAxisAngle(Y, (shot.orbit * Math.PI) / 180);
  if (shot.tilt) {
    // Up or down, short of straight over or under.
    const len = off.length(), now = Math.asin(off.y / len);
    const to = Math.max(-1.45, Math.min(1.45, now + (shot.tilt * Math.PI) / 180));
    const flat = Math.hypot(off.x, off.z) || 1;
    off.set((off.x / flat) * Math.cos(to) * len, Math.sin(to) * len, (off.z / flat) * Math.cos(to) * len);
  }
  if (shot.distance) off.multiplyScalar(shot.distance);
  p.pos.copy(p.at).add(off);
  return p;
}
// A state's numbers, blended through its flights: amounts arrive eased (by the renderer), so they're used as they are.
// How much of the state is the flat frame.
function flatOf(state) {
  if (state.from) return flatOf(state.from) + (flatOf(state.to) - flatOf(state.from)) * state.amount;
  return state.view === "flat" ? 1 : 0;
}
function stageOf(state) {
  if (state.from) return stageOf(state.from) + (stageOf(state.to) - stageOf(state.from)) * state.amount;
  return state.view === "float" ? 1 : 0;
}
function awayOf(state) {
  if (state.from) return awayOf(state.from) + (awayOf(state.to) - awayOf(state.from)) * state.amount;
  return state.view === "float" || state.hands === false ? 1 : 0;
}
function ipadOf(state) {
  if (state.from) return ipadOf(state.from) + (ipadOf(state.to) - ipadOf(state.from)) * state.amount;
  return state.view === "float" && state.ipad !== false ? 1 : 0;
}
function poseOf(state) {
  if (!state.from) return shotPose(state);
  // Between two shots of one view, the camera goes round through the angles between (a full orbit is a full turn),
  // where between views it goes straight from one place to the other.
  const f = state.from, g = state.to;
  if (!f.from && f.view === g.view && f.view !== "flat") {
    const mix = (a, b, base) => (a ?? base) + ((b ?? base) - (a ?? base)) * state.amount;
    return shotPose({ view: g.view, orbit: mix(f.orbit, g.orbit, 0), tilt: mix(f.tilt, g.tilt, 0), distance: mix(f.distance, g.distance, 1) });
  }
  const a = poseOf(state.from), b = poseOf(state.to), p = state.amount;
  return {
    pos: a.pos.lerp(b.pos, p),
    at: a.at.lerp(b.at, p),
    up: a.up.lerp(b.up, p).normalize(),
    fov: a.fov + (b.fov - a.fov) * p,
  };
}
function setCamera(state) {
  const p = poseOf(state);
  camera.position.copy(p.pos);
  camera.up.copy(p.up);
  camera.fov = p.fov;
  camera.updateProjectionMatrix();
  camera.lookAt(p.at);
}

// ---------------------------------------------------------------- render
const label = document.getElementById("label");
let screenShown = false;
// Where hands that leave go: back toward the body and down, out of every shot.
const AWAY = new THREE.Vector3(0, -6, 30);
function render(t, frame) {
  const state = frame.state ?? { view: "keyboard" };
  // The flat frame is the screen square on, so the lid is open for it: a flight to or from the flat desktop opens a
  // lower lid as it comes to the screen, and lowers it again as it leaves.
  const asked = frame.lid ?? ${DESK_LID};
  const lidDeg = asked + (Math.max(asked, ${DESK_LID}) - asked) * ease(flatOf(state));
  setLid(lidDeg);
  setStage(stageOf(state), ipadOf(state), t);
  notchMat.opacity = Math.min(1, (1 - flatOf(state)) * 6);
  glassMat.opacity = 0.07 * notchMat.opacity;
  laptop.updateMatrixWorld(true);
  for (const [id, k] of keys) {
    let amount = 0;
    for (const ev of events) for (const key of ev.keys) if (key.id === id) amount = Math.max(amount, pressAmount(ev, key, t));
    k.mesh.position.y = -KEY_TRAVEL * amount;
    k.mesh.material[0] = amount > 0.5 ? k.matLit : k.matTop;
  }
  // The hands leave for a shot without them, for the float view, and as the lid comes down onto the keys.
  const away = ease(Math.max(awayOf(state), Math.min(1, Math.max(0, (80 - lidDeg) / 35))));
  if (OPTS.hands) for (const h of Object.values(hands)) {
    h.root.visible = away < 0.999;
    if (!h.root.visible) continue;
    placeHand(h, t);
    h.root.position.addScaledVector(AWAY, away); // the whole hand, holding its pose
  }
  let shown = null, opacity = 0;
  // Labels: as the frame says (the keyboard window's setting, which can change while it's open), else the page's.
  if (frame.labels ?? OPTS.labels) {
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
  // The screen lights what's in front of it, less as the lid closes and none on the studio's stage.
  glow.intensity = screenShown ? 45 * Math.min(1, lidDeg / 90) * (1 - stageOf(state)) : 0;
  setCamera(state);
  renderer.render(scene, camera);
}
function resize(w, h) {
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
const ready = Promise.all([document.fonts.load("16px Inter").catch(() => {}), ...(OPTS.hands ? [loadHand("left"), loadHand("right")] : [])]).then(() => {
  for (const h of Object.values(hands)) placeHome(h);
});
window.__rsDesk = {
  ready,
  _debug: { REST_CURL, hands, THREE, keyCenter, keys },
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
        ipadTex.image = img;
        ipadTex.needsUpdate = true;
        ipadScreenMat.map = ipadTex;
        ipadScreenMat.color.set(0xffffff);
        ipadScreenMat.needsUpdate = true;
        screenShown = true;
        resolve();
      };
      img.onerror = () => reject(new Error("the screen's picture didn't decode"));
      img.src = url;
    });
  },
  // Draw the frame at t: the key events not given before, and { state, lid } (a DeskState, the lid in degrees).
  render(t, newEvents, frame) {
    for (const ev of newEvents) events.push(ev);
    render(t, frame ?? {});
  },
};
resize(window.innerWidth, window.innerHeight);
`;
