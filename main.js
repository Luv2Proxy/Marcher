const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });

const FIELD_SIZE = { x: 56, y: 34, z: 56 };
const CELL_SIZE = 1;
const ISO_LEVEL = 0;
const CHUNK_SIZE = 14;

const field = new Float32Array(FIELD_SIZE.x * FIELD_SIZE.y * FIELD_SIZE.z);
const chunks = new Map();
const dirtyChunks = new Set();
const terrainMaterial = new BABYLON.StandardMaterial("terrainMat", scene);
terrainMaterial.diffuseTexture = createGroundTexture(scene);
terrainMaterial.specularColor = BABYLON.Color3.Black();
terrainMaterial.useVertexColors = true;

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

  // Dispose old physics if exists
  if (chunk.mesh.physicsBody) {
    chunk.mesh.physicsBody.dispose();
  }
  
  chunk.mesh.physicsBody = new BABYLON.PhysicsBody(
    chunk.mesh,
    BABYLON.PhysicsMotionType.STATIC,
    false,
    scene
  );
  
  chunk.mesh.physicsShape = new BABYLON.PhysicsShapeMesh(
    chunk.mesh,
    scene
  );

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

function updateStats() {
  statsEl.textContent = `Triangles: ${totalTriangles().toLocaleString()} · Chunks dirty: ${dirtyChunks.size} · Brush radius: ${brushRadius.toFixed(1)} · Strength: ${brushStrength.toFixed(2)}`;
}

async function createScene() {

  const scene = new BABYLON.Scene(engine);

  scene.clearColor = new BABYLON.Color4(0.53, 0.74, 0.93, 1);
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP;
  scene.fogDensity = 0.008;
  scene.fogColor = new BABYLON.Color3(0.5, 0.7, 0.92);

  // ---------------------------
  // ENABLE HAVOK FIRST
  // ---------------------------
  const havokInstance = await HavokPhysics();
  const hk = new BABYLON.HavokPlugin(true, havokInstance);
  scene.enablePhysics(new BABYLON.Vector3(0, -9.81, 0), hk);

  // ---------------------------
  // CAMERA
  // ---------------------------
  const camera = new BABYLON.UniversalCamera(
    "cam",
    new BABYLON.Vector3(
      FIELD_SIZE.x * 0.5,
      FIELD_SIZE.y * 0.75,
      FIELD_SIZE.z * 0.5
    ),
    scene
  );

  camera.attachControl(canvas, true);

  // ---------------------------
  // PLAYER CAPSULE
  // ---------------------------
  const playerCapsule = BABYLON.MeshBuilder.CreateCapsule("player", {
    height: playerHeight,
    radius: playerRadius
  }, scene);

  playerCapsule.isVisible = false;

  playerCapsule.physicsBody = new BABYLON.PhysicsBody(
    playerCapsule,
    BABYLON.PhysicsMotionType.DYNAMIC,
    false,
    scene
  );

  playerCapsule.physicsShape = new BABYLON.PhysicsShapeCapsule(
    new BABYLON.Vector3(0, -playerHeight / 2 + playerRadius, 0),
    new BABYLON.Vector3(0, playerHeight / 2 - playerRadius, 0),
    playerRadius,
    scene
  );

  playerCapsule.physicsBody.setMassProperties({ mass: 70 });
  playerCapsule.physicsBody.setLinearDamping(0.9);
  playerCapsule.physicsBody.setAngularDamping(1);

  // ---------------------------
  // LIGHTS
  // ---------------------------
  new BABYLON.HemisphericLight("hemi",
    new BABYLON.Vector3(0.2, 1, 0.1),
    scene
  );

  // ---------------------------
  // TERRAIN INIT
  // ---------------------------
  regenerateField();
  createChunks(scene, terrainMaterial);
  markAllChunksDirty();
  rebuildDirtyChunks(scene, Infinity);

  // ---------------------------
  // GAME LOOP
  // ---------------------------
  scene.onBeforeRenderObservable.add(() => {

    camera.position.copyFrom(playerCapsule.position);

    // movement
    const forward = camera.getDirection(BABYLON.Axis.Z);
    const right = camera.getDirection(BABYLON.Axis.X);

    let move = BABYLON.Vector3.Zero();

    if (camera._keys?.includes(87)) move.addInPlace(forward);
    if (camera._keys?.includes(83)) move.subtractInPlace(forward);
    if (camera._keys?.includes(65)) move.subtractInPlace(right);
    if (camera._keys?.includes(68)) move.addInPlace(right);

    move.y = 0;

    if (move.lengthSquared() > 0) {
      move.normalize();
      playerCapsule.physicsBody.applyForce(
        move.scale(120),
        playerCapsule.position
      );
    }

    rebuildDirtyChunks(scene, 2);
  });

  return scene;
}

createScene().then(scene => {
  engine.runRenderLoop(() => scene.render());
});

window.addEventListener("resize", () => engine.resize());
