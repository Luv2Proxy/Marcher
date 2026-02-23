
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

function collidesAt(pos) {
  const footY = pos.y - playerHeight;
  const headY = pos.y - 0.1;
  const probes = [
    [0, 0],
    [playerRadius, 0],
    [-playerRadius, 0],
    [0, playerRadius],
    [0, -playerRadius],
  ];

  for (const [ox, oz] of probes) {
    if (sampleDensity(pos.x + ox, footY, pos.z + oz) >= ISO_LEVEL) return true;
    if (sampleDensity(pos.x + ox, headY, pos.z + oz) >= ISO_LEVEL) return true;
  }
  return false;
}

const pseudoNoise = (x, y, z) => {
  const a = Math.sin(x * 0.13 + z * 0.07) * 0.6;
  const b = Math.cos(z * 0.11 - x * 0.09) * 0.45;
@ -334,8 +396,6 @@ camera.keysUp = [87];
camera.keysDown = [83];
camera.keysLeft = [65];
camera.keysRight = [68];
if ("keysUpward" in camera) camera.keysUpward = [32];
if ("keysDownward" in camera) camera.keysDownward = [17, 67];
camera.attachControl(canvas, true);

const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0.2, 1, 0.1), scene);
@ -386,6 +446,10 @@ window.addEventListener("pointerup", (event) => {
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
@ -403,25 +467,49 @@
});

scene.onBeforeRenderObservable.add(() => {
  const dt = engine.getDeltaTime() * 0.001;
  const baseSpeed = scene.getEngine().isPointerLock ? 0.68 : 0.55;
  camera.speed = sprinting ? baseSpeed * 2 : baseSpeed;

  const prevPos = camera.position.clone();
  verticalVelocity -= gravity * dt;
  camera.position.y += verticalVelocity * dt;

  if (collidesAt(camera.position)) {
    if (verticalVelocity <= 0) {
      onGround = true;
      verticalVelocity = 0;
      for (let i = 0; i < 10 && collidesAt(camera.position); i++) camera.position.y += 0.05;
    } else {
      verticalVelocity = 0;
      camera.position.y = prevPos.y;
    }
  } else {
    onGround = false;
  }

  const horizontalTest = new BABYLON.Vector3(camera.position.x, prevPos.y, camera.position.z);
  if (collidesAt(horizontalTest)) {
    camera.position.x = prevPos.x;
    camera.position.z = prevPos.z;
  }

  if (isMining || isBuilding) {
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => mesh?.metadata?.terrainChunk === true);
    if (pick?.hit && pick.pickedPoint) {
      const normal = pick.getNormal(true) ?? BABYLON.Vector3.Up();
      const offsetPoint = isBuilding
        ? pick.pickedPoint.add(normal.scale(0.8))
        : pick.pickedPoint.subtract(normal.scale(0.45));

      modifyField(offsetPoint, brushRadius, isMining ? -brushStrength : brushStrength);
    }
  }

  rebuildDirtyChunks(2);
  updateStats();
});

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());
