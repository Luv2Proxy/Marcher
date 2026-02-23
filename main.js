const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });

const FIELD_SIZE = { x: 56, y: 34, z: 56 };
const CELL_SIZE = 1;
const ISO_LEVEL = 0;
const CHUNK_SIZE = 14;

const field = new Float32Array(FIELD_SIZE.x * FIELD_SIZE.y * FIELD_SIZE.z);
const chunks = new Map();
const dirtyChunks = new Set();
const pressed = new Set();

const tetrahedra = [
  [0, 5, 1, 6],
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
];

const cornerOffsets = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

const chunkCounts = {
  x: Math.ceil((FIELD_SIZE.x - 1) / CHUNK_SIZE),
  y: Math.ceil((FIELD_SIZE.y - 1) / CHUNK_SIZE),
  z: Math.ceil((FIELD_SIZE.z - 1) / CHUNK_SIZE),
};

const statsEl = document.getElementById("stats");
const getIndex = (x, y, z) => x + FIELD_SIZE.x * (y + FIELD_SIZE.y * z);
const chunkKey = (x, y, z) => `${x},${y},${z}`;

/* ================================
   PLAYER GEOMETRY CONSTRAINTS
================================ */

const PLAYER_RADIUS = 0.34;          // Capsule radius
const PLAYER_HEIGHT = 1.8;           // Total height
const PLAYER_HALF_HEIGHT = PLAYER_HEIGHT * 0.5;
const PLAYER_CLEARANCE = 0.11;       // Offset above terrain to prevent jitter
const COLLISION_SHELL = 0.05;
const PLAYER_EYE_HEIGHT = 0.72;      // Camera height offset


/* ================================
   MOVEMENT CONSTRAINTS
================================ */

const MOVE_ACCEL = 38;               // Ground acceleration
const MOVE_FRICTION = 16;            // Ground friction (velocity decay)
const AIR_CONTROL = 0.35;            // % of accel allowed in air

const MAX_SPEED = 8;                 // Base horizontal speed
const SPRINT_MULT = 1.65;            // Sprint multiplier


/* ================================
   STEP + SLOPE CONSTRAINTS
================================ */

const STEP_HEIGHT = 0.45;            // Max climbable ledge height

// Slope constraint (~56° max walkable angle)
const MAX_SLOPE_DOT = 0.55;          
// Equivalent to: groundNormal.dot(Up) > 0.55

const GROUND_STICK_FORCE = 4;        // Keeps player glued to slopes


/* ================================
   GRAVITY + JUMP CONSTRAINTS
================================ */

const GRAVITY = 24;                  // Downward acceleration
const JUMP_FORCE = 8.5;              // Jump impulse


/* ================================
   GROUND DETECTION CONSTRAINTS
================================ */

const GROUND_SEARCH_DEPTH = 2;       // How far down to scan for ground
const GROUND_SAMPLE_STEP = 0.1;      // Vertical scan resolution
const NORMAL_SAMPLE_EPS = 0.05;      // Density gradient sampling offset


/* ================================
   STATE CONSTRAINTS
================================ */

// Grounded only if:
// 1. Ground detected within search depth
// 2. Slope is walkable (normal · up > MAX_SLOPE_DOT)
// 3. Vertical velocity <= 0

// Horizontal speed always clamped to:
// MAX_SPEED * (sprinting ? SPRINT_MULT : 1)

// Jump only allowed if grounded == true

// Position integration always follows:
// position += velocity * dt

// No artificial vertical pushes
// No post-penetration boost corrections
// No terrain-induced velocity stacking

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function sampleDensity(x, y, z) {
  const fx = clamp(x, 0, FIELD_SIZE.x - 1.001);
  const fy = clamp(y, 0, FIELD_SIZE.y - 1.001);
  const fz = clamp(z, 0, FIELD_SIZE.z - 1.001);

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, FIELD_SIZE.x - 1);
  const y1 = Math.min(y0 + 1, FIELD_SIZE.y - 1);
  const z1 = Math.min(z0 + 1, FIELD_SIZE.z - 1);

  const tx = fx - x0;
  const ty = fy - y0;
  const tz = fz - z0;

  const c000 = field[getIndex(x0, y0, z0)];
  const c100 = field[getIndex(x1, y0, z0)];
  const c010 = field[getIndex(x0, y1, z0)];
  const c110 = field[getIndex(x1, y1, z0)];
  const c001 = field[getIndex(x0, y0, z1)];
  const c101 = field[getIndex(x1, y0, z1)];
  const c011 = field[getIndex(x0, y1, z1)];
  const c111 = field[getIndex(x1, y1, z1)];

  const c00 = c000 * (1 - tx) + c100 * tx;
  const c10 = c010 * (1 - tx) + c110 * tx;
  const c01 = c001 * (1 - tx) + c101 * tx;
  const c11 = c011 * (1 - tx) + c111 * tx;

  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;
  return c0 * (1 - tz) + c1 * tz;
}


function getGroundInfo(playerPos) {

  const down = GROUND_SEARCH_DEPTH;
  const step = GROUND_SAMPLE_STEP;

  // Start from bottom of capsule
  const footY = playerPos.y - PLAYER_HALF_HEIGHT + PLAYER_CLEARANCE;

  let previousDensity = sampleDensity(playerPos.x, footY, playerPos.z);

  for (let y = footY - step; y > footY - down; y -= step) {

    const d = sampleDensity(playerPos.x, y, playerPos.z);

    // Detect air -> solid transition
    if (previousDensity < ISO_LEVEL && d >= ISO_LEVEL) {

      // Binary refinement
      let y0 = y;
      let y1 = y + step;

      for (let i = 0; i < 5; i++) {
        const mid = (y0 + y1) * 0.5;
        const dm = sampleDensity(playerPos.x, mid, playerPos.z);
        if (dm >= ISO_LEVEL) y0 = mid;
        else y1 = mid;
      }

      const groundY = (y0 + y1) * 0.5;

      const eps = NORMAL_SAMPLE_EPS;

      const nx =
        sampleDensity(playerPos.x + eps, groundY, playerPos.z) -
        sampleDensity(playerPos.x - eps, groundY, playerPos.z);

      const ny =
        sampleDensity(playerPos.x, groundY + eps, playerPos.z) -
        sampleDensity(playerPos.x, groundY - eps, playerPos.z);

      const nz =
        sampleDensity(playerPos.x, groundY, playerPos.z + eps) -
        sampleDensity(playerPos.x, groundY, playerPos.z - eps);

      const normal = new BABYLON.Vector3(nx, ny, nz).normalize();

      return { y: groundY, normal };
    }

    previousDensity = d;
  }

  return null;
}

function collidesAt(position) {
  const bottom = position.y - PLAYER_HALF_HEIGHT + 0.06;
  const top = position.y + PLAYER_HALF_HEIGHT - 0.05;
  const rings = [bottom, bottom + (top - bottom) * 0.25, bottom + (top - bottom) * 0.5, bottom + (top - bottom) * 0.75, top];
  const radial = PLAYER_RADIUS + COLLISION_SHELL;
  const offsets = [
    [0, 0],
    [radial, 0],
    [-radial, 0],
    [0, radial],
    [0, -radial],
    [radial * 0.72, radial * 0.72],
    [-radial * 0.72, radial * 0.72],
    [radial * 0.72, -radial * 0.72],
    [-radial * 0.72, -radial * 0.72],
  ];

  for (const y of rings) {
    for (const [ox, oz] of offsets) {
      if (sampleDensity(position.x + ox, y, position.z + oz) >= ISO_LEVEL) return true;
    }
  }

  return false;
}

function samplePlayerPenetration(playerPos) {
  const bottom = playerPos.y - PLAYER_HALF_HEIGHT + 0.07;
  const top = playerPos.y + PLAYER_HALF_HEIGHT - 0.1;
  const rings = [bottom, bottom + (top - bottom) * 0.33, bottom + (top - bottom) * 0.66, top];
  const radial = PLAYER_RADIUS + COLLISION_SHELL * 0.35;
  const offsets = [
    [0, 0],
    [radial, 0],
    [-radial, 0],
    [0, radial],
    [0, -radial],
    [radial * 0.7, radial * 0.7],
    [-radial * 0.7, radial * 0.7],
    [radial * 0.7, -radial * 0.7],
    [-radial * 0.7, -radial * 0.7],
  ];

  let maxDensity = -Infinity;
  let insideCount = 0;
  let samples = 0;
  for (const y of rings) {
    for (const [ox, oz] of offsets) {
      const d = sampleDensity(playerPos.x + ox, y, playerPos.z + oz);
      maxDensity = Math.max(maxDensity, d);
      if (d >= ISO_LEVEL) insideCount += 1;
      samples += 1;
    }
  }

  return {
    depth: Math.max(0, maxDensity - ISO_LEVEL),
    coverage: insideCount / samples,
  };
}

function tryResolveLateralClip(playerState, preferredDir, step = 0.06) {
  const basis = (preferredDir && preferredDir.lengthSquared() > 1e-6)
    ? preferredDir.clone().normalize()
    : new BABYLON.Vector3(1, 0, 0);
  basis.y = 0;
  if (basis.lengthSquared() < 1e-6) basis.x = 1;
  basis.normalize();

  const perp = new BABYLON.Vector3(-basis.z, 0, basis.x);
  const candidates = [
    basis,
    perp,
    perp.scale(-1),
    basis.scale(-1),
    new BABYLON.Vector3(1, 0, 0),
    new BABYLON.Vector3(-1, 0, 0),
    new BABYLON.Vector3(0, 0, 1),
    new BABYLON.Vector3(0, 0, -1),
  ];

  for (const dir of candidates) {
    const delta = dir.normalize().scale(step);
    const testPos = playerState.position.add(delta);
    if (!collidesAt(testPos)) {
      playerState.position.copyFrom(testPos);
      return true;
    }
  }

  return false;
}

const pseudoNoise = (x, y, z) => {
  const a = Math.sin(x * 0.13 + z * 0.07) * 0.6;
  const b = Math.cos(z * 0.11 - x * 0.09) * 0.45;
  const c = Math.sin((x + z) * 0.05 + y * 0.2) * 0.4;
  return a + b + c;
};

const terrainHeight = (x, z) => {
  const rolling = Math.sin(x * 0.08) * 2.2 + Math.cos(z * 0.07) * 2.3;
  const mesas = Math.sin((x + z) * 0.03) * 2;
  return FIELD_SIZE.y * 0.45 + rolling + mesas;
};

function createGroundTexture(scene) {
  const tex = new BABYLON.DynamicTexture("groundTex", { width: 256, height: 256 }, scene, false);
  const ctx = tex.getContext();
  ctx.fillStyle = "#8d7a64";
  ctx.fillRect(0, 0, 256, 256);

  for (let i = 0; i < 3200; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const shade = 105 + Math.random() * 55;
    ctx.fillStyle = `rgba(${shade}, ${shade * 0.9}, ${shade * 0.75}, 0.25)`;
    ctx.fillRect(x, y, 2, 2);
  }

  for (let i = 0; i < 350; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 1 + Math.random() * 2;
    ctx.fillStyle = "rgba(75, 62, 48, 0.35)";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  tex.update(false);
  tex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
  tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

function regenerateField() {
  for (let z = 0; z < FIELD_SIZE.z; z++) {
    for (let y = 0; y < FIELD_SIZE.y; y++) {
      for (let x = 0; x < FIELD_SIZE.x; x++) {
        const surface = terrainHeight(x, z);
        const baseDensity = surface - y;
        const cave = pseudoNoise(x, y, z) - 0.55;
        const stratification = Math.sin(y * 0.35 + x * 0.02) * 0.22;
        field[getIndex(x, y, z)] = baseDensity + cave * 1.1 + stratification;
      }
    }
  }
}

function interpolate(p1, p2, v1, v2) {
  const t = BABYLON.Scalar.Clamp((ISO_LEVEL - v1) / (v2 - v1 + 1e-6), 0, 1);
  return new BABYLON.Vector3(
    p1.x + (p2.x - p1.x) * t,
    p1.y + (p2.y - p1.y) * t,
    p1.z + (p2.z - p1.z) * t,
  );
}

function polygonizeTetra(points, values, positions, indices) {
  const inside = [];
  const outside = [];
  for (let i = 0; i < 4; i++) {
    (values[i] >= ISO_LEVEL ? inside : outside).push(i);
  }
  if (inside.length === 0 || inside.length === 4) return;

  const emitTriangle = (a, b, c) => {
    const base = positions.length / 3;
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    indices.push(base, base + 1, base + 2);
  };

  if (inside.length === 1 || inside.length === 3) {
    const invert = inside.length === 3;
    const center = invert ? outside[0] : inside[0];
    const ring = invert ? inside : outside;
    const pA = interpolate(points[center], points[ring[0]], values[center], values[ring[0]]);
    const pB = interpolate(points[center], points[ring[1]], values[center], values[ring[1]]);
    const pC = interpolate(points[center], points[ring[2]], values[center], values[ring[2]]);
    if (invert) emitTriangle(pA, pC, pB);
    else emitTriangle(pA, pB, pC);
    return;
  }

  const p0 = inside[0];
  const p1 = inside[1];
  const o0 = outside[0];
  const o1 = outside[1];
  const a = interpolate(points[p0], points[o0], values[p0], values[o0]);
  const b = interpolate(points[p0], points[o1], values[p0], values[o1]);
  const c = interpolate(points[p1], points[o0], values[p1], values[o0]);
  const d = interpolate(points[p1], points[o1], values[p1], values[o1]);
  emitTriangle(a, c, b);
  emitTriangle(b, c, d);
}

function buildChunkMesh(chunk, scene) {
  const positions = [];
  const indices = [];

  for (let z = chunk.minCell.z; z < chunk.maxCell.z; z++) {
    for (let y = chunk.minCell.y; y < chunk.maxCell.y; y++) {
      for (let x = chunk.minCell.x; x < chunk.maxCell.x; x++) {
        const cubePoints = cornerOffsets.map(([ox, oy, oz]) =>
          new BABYLON.Vector3((x + ox) * CELL_SIZE, (y + oy) * CELL_SIZE, (z + oz) * CELL_SIZE),
        );
        const cubeValues = cornerOffsets.map(([ox, oy, oz]) => field[getIndex(x + ox, y + oy, z + oz)]);

        for (const tet of tetrahedra) {
          const tPoints = tet.map((i) => cubePoints[i]);
          const tValues = tet.map((i) => cubeValues[i]);
          polygonizeTetra(tPoints, tValues, positions, indices);
        }
      }
    }
  }

  if (indices.length === 0) {
    chunk.mesh.setEnabled(false);
    chunk.triangleCount = 0;
    return;
  }

  const normals = [];
  BABYLON.VertexData.ComputeNormals(positions, indices, normals);

  const uvs = [];
  const colors = [];
  for (let i = 0; i < positions.length; i += 3) {
    const px = positions[i];
    const py = positions[i + 1];
    const pz = positions[i + 2];
    uvs.push(px * 0.07, pz * 0.07);

    const h = py / FIELD_SIZE.y;
    if (h > 0.62) colors.push(0.36, 0.75, 0.39, 1);
    else if (h > 0.44) colors.push(0.53, 0.4, 0.28, 1);
    else colors.push(0.24, 0.25, 0.3, 1);
  }

  const vd = new BABYLON.VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.uvs = uvs;
  vd.colors = colors;
  vd.applyToMesh(chunk.mesh, true);

  chunk.mesh.setEnabled(true);
  chunk.mesh.isPickable = true;
  chunk.mesh.receiveShadows = false;
  chunk.triangleCount = indices.length / 3;

}

function rebuildDirtyChunks(scene, maxPerFrame = Infinity) {
  let built = 0;
  for (const key of dirtyChunks) {
    const chunk = chunks.get(key);
    if (!chunk) continue;
    buildChunkMesh(chunk, scene);
    dirtyChunks.delete(key);
    built += 1;
    if (built >= maxPerFrame) break;
  }
}

function markAllChunksDirty() {
  chunks.forEach((_, key) => dirtyChunks.add(key));
}

function markChunksDirtyByVoxelBounds(min, max) {
  const cellMin = {
    x: Math.max(0, min.x - 1),
    y: Math.max(0, min.y - 1),
    z: Math.max(0, min.z - 1),
  };
  const cellMax = {
    x: Math.min(FIELD_SIZE.x - 2, max.x),
    y: Math.min(FIELD_SIZE.y - 2, max.y),
    z: Math.min(FIELD_SIZE.z - 2, max.z),
  };

  const minChunk = {
    x: Math.floor(cellMin.x / CHUNK_SIZE),
    y: Math.floor(cellMin.y / CHUNK_SIZE),
    z: Math.floor(cellMin.z / CHUNK_SIZE),
  };
  const maxChunk = {
    x: Math.floor(cellMax.x / CHUNK_SIZE),
    y: Math.floor(cellMax.y / CHUNK_SIZE),
    z: Math.floor(cellMax.z / CHUNK_SIZE),
  };

  for (let cz = minChunk.z; cz <= maxChunk.z; cz++) {
    for (let cy = minChunk.y; cy <= maxChunk.y; cy++) {
      for (let cx = minChunk.x; cx <= maxChunk.x; cx++) {
        dirtyChunks.add(chunkKey(cx, cy, cz));
      }
    }
  }
}

function modifyField(point, radius, amount) {
  const min = {
    x: Math.max(1, Math.floor(point.x - radius)),
    y: Math.max(1, Math.floor(point.y - radius)),
    z: Math.max(1, Math.floor(point.z - radius)),
  };
  const max = {
    x: Math.min(FIELD_SIZE.x - 2, Math.ceil(point.x + radius)),
    y: Math.min(FIELD_SIZE.y - 2, Math.ceil(point.y + radius)),
    z: Math.min(FIELD_SIZE.z - 2, Math.ceil(point.z + radius)),
  };

  for (let z = min.z; z <= max.z; z++) {
    for (let y = min.y; y <= max.y; y++) {
      for (let x = min.x; x <= max.x; x++) {
        const dx = x - point.x;
        const dy = y - point.y;
        const dz = z - point.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > radius) continue;

        const falloff = Math.pow(1 - dist / radius, 2);
        field[getIndex(x, y, z)] += amount * falloff;
      }
    }
  }

  markChunksDirtyByVoxelBounds(min, max);
}

function createChunks(scene, material) {
  for (let cz = 0; cz < chunkCounts.z; cz++) {
    for (let cy = 0; cy < chunkCounts.y; cy++) {
      for (let cx = 0; cx < chunkCounts.x; cx++) {
        const minCell = {
          x: cx * CHUNK_SIZE,
          y: cy * CHUNK_SIZE,
          z: cz * CHUNK_SIZE,
        };
        const maxCell = {
          x: Math.min((cx + 1) * CHUNK_SIZE, FIELD_SIZE.x - 1),
          y: Math.min((cy + 1) * CHUNK_SIZE, FIELD_SIZE.y - 1),
          z: Math.min((cz + 1) * CHUNK_SIZE, FIELD_SIZE.z - 1),
        };

        const mesh = new BABYLON.Mesh(`terrain-${cx}-${cy}-${cz}`, scene);
        mesh.material = material;
        mesh.metadata = { terrainChunk: true, key: chunkKey(cx, cy, cz) };

        chunks.set(chunkKey(cx, cy, cz), {
          key: chunkKey(cx, cy, cz),
          minCell,
          maxCell,
          mesh,
          triangleCount: 0,
        });
      }
    }
  }
}

function totalTriangles() {
  let triangles = 0;
  chunks.forEach((c) => (triangles += c.triangleCount));
  return triangles;
}

function updateStats(brushRadius, brushStrength) {
  statsEl.textContent = `Triangles: ${totalTriangles().toLocaleString()} · Chunks dirty: ${dirtyChunks.size} · Brush radius: ${brushRadius.toFixed(1)} · Strength: ${brushStrength.toFixed(2)}`;
}

async function createScene() {
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.53, 0.74, 0.93, 1);
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP;
  scene.fogDensity = 0.008;
  scene.fogColor = new BABYLON.Color3(0.5, 0.7, 0.92);

  const camera = new BABYLON.UniversalCamera(
    "cam",
    new BABYLON.Vector3(FIELD_SIZE.x * 0.5, FIELD_SIZE.y * 0.75, FIELD_SIZE.z * 0.5),
    scene,
  );
  camera.setTarget(new BABYLON.Vector3(FIELD_SIZE.x * 0.5, FIELD_SIZE.y * 0.45, FIELD_SIZE.z * 0.6));
  camera.minZ = 0.1;
  camera.maxZ = 200;
  camera.speed = 0;
  camera.inertia = 0;
  camera.attachControl(canvas, true);

  const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0.2, 1, 0.1), scene);
  hemi.intensity = 0.55;

  const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.4, -1, 0.2), scene);
  sun.position = new BABYLON.Vector3(70, 100, -40);
  sun.intensity = 0.8;

  const terrainMaterial = new BABYLON.StandardMaterial("terrainMat", scene);
  terrainMaterial.specularColor = new BABYLON.Color3(0.04, 0.04, 0.04);
  terrainMaterial.ambientColor = new BABYLON.Color3(0.45, 0.45, 0.45);
  terrainMaterial.useVertexColor = true;
  terrainMaterial.diffuseTexture = createGroundTexture(scene);
  terrainMaterial.diffuseTexture.level = 0.9;
  terrainMaterial.backFaceCulling = false;
  terrainMaterial.twoSidedLighting = true;

  const sky = BABYLON.MeshBuilder.CreateSphere("sky", { diameter: 500, sideOrientation: BABYLON.Mesh.BACKSIDE }, scene);
  const skyMat = new BABYLON.StandardMaterial("skyMat", scene);
  skyMat.disableLighting = true;
  skyMat.emissiveColor = new BABYLON.Color3(0.42, 0.66, 0.95);
  sky.material = skyMat;

  const pickFromCrosshair = (predicate) => {
    const x = engine.getRenderWidth() * 0.5;
    const y = engine.getRenderHeight() * 0.5;
    return scene.pick(x, y, predicate, false, camera);
  };

  const player = {
  position: new BABYLON.Vector3(FIELD_SIZE.x * 0.5, FIELD_SIZE.y * 0.75, FIELD_SIZE.z * 0.5),
  velocity: new BABYLON.Vector3(0, 0, 0),
  grounded: false,
  groundNormal: BABYLON.Vector3.Up()
};

  let brushRadius = 2.7;
  let brushStrength = 1.05;
  let isMining = false;
  let isBuilding = false;
  let sprinting = false;

  regenerateField();
  createChunks(scene, terrainMaterial);
  markAllChunksDirty();
  rebuildDirtyChunks(scene, Infinity);

  window.addEventListener("contextmenu", (event) => event.preventDefault());
  window.addEventListener("pointerdown", (event) => {
    if (event.button === 0) isMining = true;
    if (event.button === 2) isBuilding = true;
    canvas.requestPointerLock();
  });
  window.addEventListener("pointerup", (event) => {
    if (event.button === 0) isMining = false;
    if (event.button === 2) isBuilding = false;
  });

  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    pressed.add(key);
    if (key === "shift") sprinting = true;
    if (key === "q") brushRadius = Math.max(1, brushRadius - 0.35);
    if (key === "e") brushRadius = Math.min(8, brushRadius + 0.35);
    if (key === "z") brushStrength = Math.max(0.2, brushStrength - 0.1);
    if (key === "x") brushStrength = Math.min(3, brushStrength + 0.1);
    if (key === "r") {
      regenerateField();
      markAllChunksDirty();
      rebuildDirtyChunks(scene, Infinity);
    }
    updateStats(brushRadius, brushStrength);
  });

  window.addEventListener("keyup", (event) => {
    const key = event.key.toLowerCase();
    pressed.delete(key);
    if (key === "shift") sprinting = false;
  });

  scene.onBeforeRenderObservable.add(() => {
    const dt = Math.min(0.033, engine.getDeltaTime() / 1000);
  
    const forward = camera.getDirection(BABYLON.Axis.Z).normalize();
    const right = camera.getDirection(BABYLON.Axis.X).normalize();
    forward.y = 0;
    right.y = 0;
    forward.normalize();
    right.normalize();
  
    let input = new BABYLON.Vector3(0, 0, 0);
    if (pressed.has("w")) input.addInPlace(forward);
    if (pressed.has("s")) input.subtractInPlace(forward);
    if (pressed.has("a")) input.subtractInPlace(right);
    if (pressed.has("d")) input.addInPlace(right);
  
    const isMoving = input.lengthSquared() > 0.001;
    if (isMoving) input.normalize();
  
    const targetSpeed = sprinting ? MAX_SPEED * SPRINT_MULT : MAX_SPEED;
  
    // --- ACCELERATION ---
    if (isMoving) {
      const accel = player.grounded ? MOVE_ACCEL : MOVE_ACCEL * AIR_CONTROL;
      player.velocity.x += input.x * accel * dt;
      player.velocity.z += input.z * accel * dt;
    } else {
      const friction = player.grounded ? MOVE_FRICTION : MOVE_FRICTION * 0.1;
      player.velocity.x -= player.velocity.x * friction * dt;
      player.velocity.z -= player.velocity.z * friction * dt;
    }
  
    // Clamp horizontal speed
    const horizontalSpeed = Math.sqrt(player.velocity.x**2 + player.velocity.z**2);
    if (horizontalSpeed > targetSpeed) {
      const scale = targetSpeed / horizontalSpeed;
      player.velocity.x *= scale;
      player.velocity.z *= scale;
    }
  
    // ------------------------
    // VERTICAL + GROUND LOGIC
    // ------------------------
    
    /* 1️⃣ Apply gravity */
    player.velocity.y -= GRAVITY * dt;
    player.velocity.y = Math.max(player.velocity.y, -30);
    
    /* 2️⃣ Integrate vertical */
    player.position.y += player.velocity.y * dt;
    
    /* 3️⃣ Ground detection */
    const groundInfo = getGroundInfo(player.position);
    
    if (groundInfo) {
    
      const desiredY =
        groundInfo.y +
        PLAYER_HALF_HEIGHT +
        PLAYER_CLEARANCE;
    
      const slopeDot = groundInfo.normal.dot(BABYLON.Vector3.Up());
    
      if (
        slopeDot > MAX_SLOPE_DOT &&
        player.velocity.y <= 0 &&
        player.position.y <= desiredY + 0.05
      ) {
        player.position.y = desiredY;
        player.velocity.y = 0;
        player.grounded = true;
        player.groundNormal = groundInfo.normal;
      } else {
        player.grounded = false;
      }
    
    } else {
      player.grounded = false;
    }
    
    /* 4️⃣ Jump */
    if (pressed.has(" ") && player.grounded) {
      player.velocity.y = JUMP_FORCE;
      player.grounded = false;
    }
  
    camera.position.copyFrom(player.position).addInPlace(new BABYLON.Vector3(0, PLAYER_EYE_HEIGHT, 0));
  });

  return scene;
}

createScene().then((scene) => {
  engine.runRenderLoop(() => scene.render());
});

window.addEventListener("resize", () => engine.resize());
