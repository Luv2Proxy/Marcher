const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });

const FIELD_SIZE = { x: 56, y: 34, z: 56 };
const CELL_SIZE = 1;
const ISO_LEVEL = 0;
const CHUNK_SIZE = 14;

const field = new Float32Array(FIELD_SIZE.x * FIELD_SIZE.y * FIELD_SIZE.z);
const chunks = new Map();
const dirtyChunks = new Set();

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

const playerRadius = 0.35;
const playerHeight = 1.75;
const gravity = 26;
const jumpSpeed = 8.8;
let verticalVelocity = 0;
let onGround = false;

const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));

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

function capsuleCollides(pos) {
  const steps = 6; // vertical samples
  const bottom = pos.y - playerHeight;
  const top = pos.y - 0.1;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = bottom + (top - bottom) * t;

    const probes = [
      [0, 0],
      [playerRadius, 0],
      [-playerRadius, 0],
      [0, playerRadius],
      [0, -playerRadius],
      [playerRadius * 0.7, playerRadius * 0.7],
      [-playerRadius * 0.7, playerRadius * 0.7],
      [playerRadius * 0.7, -playerRadius * 0.7],
      [-playerRadius * 0.7, -playerRadius * 0.7],
    ];

    for (const [ox, oz] of probes) {
      if (sampleDensity(pos.x + ox, y, pos.z + oz) >= ISO_LEVEL) {
        return true;
      }
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

function buildChunkMesh(chunk) {
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

  chunk.mesh.isPickable = true;
  chunk.mesh.receiveShadows = false;
  chunk.triangleCount = indices.length / 3;
}

function rebuildDirtyChunks(maxPerFrame = Infinity) {
  let built = 0;
  for (const key of dirtyChunks) {
    const chunk = chunks.get(key);
    if (!chunk) continue;
    buildChunkMesh(chunk);
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

function updateStats() {
  statsEl.textContent = `Triangles: ${totalTriangles().toLocaleString()} · Chunks dirty: ${dirtyChunks.size} · Brush radius: ${brushRadius.toFixed(1)} · Strength: ${brushStrength.toFixed(2)}`;
}

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
camera.speed = 0.55;
camera.minZ = 0.1;
camera.maxZ = 200;
camera.keysUp = [87];
camera.keysDown = [83];
camera.keysLeft = [65];
camera.keysRight = [68];
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

let brushRadius = 2.7;
let brushStrength = 1.05;

regenerateField();
createChunks(scene, terrainMaterial);
markAllChunksDirty();
rebuildDirtyChunks(Infinity);

let isMining = false;
let isBuilding = false;
let sprinting = false;

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
  if (key === "shift") sprinting = true;
  if (key === " " && onGround) {
    verticalVelocity = jumpSpeed;
    onGround = false;
  }
  if (key === "q") brushRadius = Math.max(1, brushRadius - 0.35);
  if (key === "e") brushRadius = Math.min(8, brushRadius + 0.35);
  if (key === "z") brushStrength = Math.max(0.2, brushStrength - 0.1);
  if (key === "x") brushStrength = Math.min(3, brushStrength + 0.1);
  if (key === "r") {
    regenerateField();
    markAllChunksDirty();
    rebuildDirtyChunks(Infinity);
  }
  updateStats();
});

function tryStep(originalPos, axis) {
  const stepHeight = 0.4;

  const testPos = originalPos.clone();
  camera.position.copyFrom(testPos);

  // attempt small lift
  camera.position.y += stepHeight;

  // check full capsule
  if (!capsuleCollides(camera.position)) {
    // now check that we're not pushing into ceiling
    const headCheck = camera.position.clone();
    headCheck.y += 0.05;

    if (!capsuleCollides(headCheck)) {
      return true; // valid step
    }
  }

  camera.position.copyFrom(originalPos);
  return false;
}

window.addEventListener("keyup", (event) => {
  if (event.key.toLowerCase() === "shift") sprinting = false;
});

scene.onBeforeRenderObservable.add(() => {
  const dt = engine.getDeltaTime() * 0.001;

  const prev = camera.position.clone();

  // -------------------------
  // GRAVITY
  // -------------------------
  verticalVelocity -= gravity * dt;
  camera.position.y += verticalVelocity * dt;

  // -------------------------
  // VERTICAL COLLISION
  // -------------------------
  if (capsuleCollides(camera.position)) {
    if (verticalVelocity <= 0) {
      // Falling onto ground
      onGround = true;
      verticalVelocity = 0;

      // Precise upward correction (no climbing)
      let push = 0;
      const maxPush = 0.25; // small only
      while (capsuleCollides(camera.position) && push < maxPush) {
        camera.position.y += 0.01;
        push += 0.01;
      }

      // If still colliding, revert fully
      if (capsuleCollides(camera.position)) {
        camera.position.y = prev.y;
      }

    } else {
      // Hit ceiling
      verticalVelocity = 0;
      camera.position.y = prev.y;
    }
  } else {
    onGround = false;
  }

  // -------------------------
  // HORIZONTAL MOVEMENT
  // -------------------------
  const desired = camera.position.clone();
  const stepHeight = 0.4;

  // ---- X Axis ----
  camera.position.x = desired.x;
  camera.position.z = prev.z;

  if (capsuleCollides(camera.position)) {
    const original = camera.position.clone();

    // Attempt step
    camera.position.y += stepHeight;

    if (
      !capsuleCollides(camera.position) &&
      !capsuleCollides(
        new BABYLON.Vector3(
          camera.position.x,
          camera.position.y + 0.05,
          camera.position.z
        )
      )
    ) {
      // successful step
    } else {
      camera.position.copyFrom(original);
      camera.position.x = prev.x;
    }
  }

  // ---- Z Axis ----
  camera.position.z = desired.z;

  if (capsuleCollides(camera.position)) {
    const original = camera.position.clone();

    camera.position.y += stepHeight;

    if (
      !capsuleCollides(camera.position) &&
      !capsuleCollides(
        new BABYLON.Vector3(
          camera.position.x,
          camera.position.y + 0.05,
          camera.position.z
        )
      )
    ) {
      // successful step
    } else {
      camera.position.copyFrom(original);
      camera.position.z = prev.z;
    }
  }

  // -------------------------
  // MINING / BUILDING
  // -------------------------
  if (isMining || isBuilding) {
    const pick = scene.pick(
      scene.pointerX,
      scene.pointerY,
      (m) => m?.metadata?.terrainChunk === true
    );

    if (pick?.hit && pick.pickedPoint) {
      const normal = pick.getNormal(true) ?? BABYLON.Vector3.Up();

      const offsetPoint = isBuilding
        ? pick.pickedPoint.add(normal.scale(0.8))
        : pick.pickedPoint.subtract(normal.scale(0.45));

      modifyField(
        offsetPoint,
        brushRadius,
        isMining ? -brushStrength : brushStrength
      );
    }
  }

  rebuildDirtyChunks(2);
  updateStats();
});

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());
