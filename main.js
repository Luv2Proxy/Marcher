const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });

/* ================================
   FIELD / MARCHING CUBES SETTINGS
================================ */

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
   PLAYER SETTINGS
================================ */

const PLAYER_RADIUS = 0.34;
const PLAYER_HEIGHT = 1.8;
const PLAYER_HALF_HEIGHT = PLAYER_HEIGHT * 0.5;
const PLAYER_CLEARANCE = 0.11;
const PLAYER_EYE_HEIGHT = 0.72;
const COLLISION_SHELL = 0.05;

const MOVE_ACCEL = 38;
const MOVE_FRICTION = 16;
const AIR_CONTROL = 0.35;

const MAX_SPEED = 8;
const SPRINT_MULT = 1.65;

const STEP_HEIGHT = 0.45;
const MAX_SLOPE_DOT = 0.55;
const GROUND_STICK_FORCE = 4;

const GRAVITY = 24;
const JUMP_FORCE = 8.5;

const GROUND_SEARCH_DEPTH = 2;
const GROUND_SAMPLE_STEP = 0.1;
const NORMAL_SAMPLE_EPS = 0.05;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/* ================================
   DENSITY FIELD / TERRAIN
================================ */

function sampleDensity(x, y, z) {
  const fx = clamp(x, 0, FIELD_SIZE.x - 1.001);
  const fy = clamp(y, 0, FIELD_SIZE.y - 1.001);
  const fz = clamp(z, 0, FIELD_SIZE.z - 1.001);

  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, FIELD_SIZE.x - 1);
  const y1 = Math.min(y0 + 1, FIELD_SIZE.y - 1);
  const z1 = Math.min(z0 + 1, FIELD_SIZE.z - 1);

  const tx = fx - x0, ty = fy - y0, tz = fz - z0;

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

function getGroundInfo(pos) {
  let prevDensity = sampleDensity(pos.x, pos.y, pos.z);
  for (let y = pos.y - GROUND_SAMPLE_STEP; y > pos.y - GROUND_SEARCH_DEPTH; y -= GROUND_SAMPLE_STEP) {
    const d = sampleDensity(pos.x, y, pos.z);
    if (prevDensity < ISO_LEVEL && d >= ISO_LEVEL) {
      let y0 = y, y1 = y + GROUND_SAMPLE_STEP;
      for (let i = 0; i < 4; i++) {
        const mid = (y0 + y1) * 0.5;
        sampleDensity(pos.x, mid, pos.z) >= ISO_LEVEL ? y0 = mid : y1 = mid;
      }
      const groundY = (y0 + y1) * 0.5;
      const eps = NORMAL_SAMPLE_EPS;
      const nx = sampleDensity(pos.x + eps, groundY, pos.z) - sampleDensity(pos.x - eps, groundY, pos.z);
      const ny = sampleDensity(pos.x, groundY + eps, pos.z) - sampleDensity(pos.x, groundY - eps, pos.z);
      const nz = sampleDensity(pos.x, groundY, pos.z + eps) - sampleDensity(pos.x, groundY, pos.z - eps);
      return { y: groundY, normal: new BABYLON.Vector3(nx, ny, nz).normalize() };
    }
    prevDensity = d;
  }
  return null;
}

function collidesAt(position) {
  const bottom = position.y - PLAYER_HALF_HEIGHT + 0.06;
  const top = position.y + PLAYER_HALF_HEIGHT - 0.05;
  const rings = [bottom, bottom + (top - bottom) * 0.25, bottom + (top - bottom) * 0.5, bottom + (top - bottom) * 0.75, top];
  const radial = PLAYER_RADIUS + COLLISION_SHELL;
  const offsets = [
    [0,0],[radial,0],[-radial,0],[0,radial],[0,-radial],
    [radial*0.72,radial*0.72],[-radial*0.72,radial*0.72],[radial*0.72,-radial*0.72],[-radial*0.72,-radial*0.72]
  ];

  for (const y of rings) {
    for (const [ox, oz] of offsets) {
      if (sampleDensity(position.x + ox, y, position.z + oz) >= ISO_LEVEL) return true;
    }
  }
  return false;
}

const pseudoNoise = (x, y, z) => Math.sin(x*0.13+z*0.07)*0.6 + Math.cos(z*0.11-x*0.09)*0.45 + Math.sin((x+z)*0.05+y*0.2)*0.4;
const terrainHeight = (x, z) => FIELD_SIZE.y*0.45 + Math.sin(x*0.08)*2.2 + Math.cos(z*0.07)*2.3 + Math.sin((x+z)*0.03)*2;

function regenerateField() {
  for (let z=0; z<FIELD_SIZE.z; z++) {
    for (let y=0; y<FIELD_SIZE.y; y++) {
      for (let x=0; x<FIELD_SIZE.x; x++) {
        const surface = terrainHeight(x,z);
        const base = surface - y;
        const cave = pseudoNoise(x,y,z)-0.55;
        const strat = Math.sin(y*0.35+x*0.02)*0.22;
        field[getIndex(x,y,z)] = base + cave*1.1 + strat;
      }
    }
  }
}

/* ================================
   MARCHING CUBES / CHUNK MESH
================================ */

function interpolate(p1,p2,v1,v2){
  const t = BABYLON.Scalar.Clamp((ISO_LEVEL - v1)/(v2 - v1 + 1e-6),0,1);
  return new BABYLON.Vector3(
    p1.x + (p2.x - p1.x)*t,
    p1.y + (p2.y - p1.y)*t,
    p1.z + (p2.z - p1.z)*t
  );
}

function polygonizeTetra(points, values, positions, indices){
  const inside=[],outside=[];
  for(let i=0;i<4;i++) (values[i]>=ISO_LEVEL?inside:outside).push(i);
  if(inside.length===0||inside.length===4) return;

  const emitTriangle=(a,b,c)=>{
    const base = positions.length/3;
    positions.push(a.x,a.y,a.z,b.x,b.y,b.z,c.x,c.y,c.z);
    indices.push(base,base+1,base+2);
  };

  if(inside.length===1||inside.length===3){
    const invert=inside.length===3;
    const center = invert ? outside[0]:inside[0];
    const ring = invert ? inside:outside;
    const pA = interpolate(points[center], points[ring[0]], values[center], values[ring[0]]);
    const pB = interpolate(points[center], points[ring[1]], values[center], values[ring[1]]);
    const pC = interpolate(points[center], points[ring[2]], values[center], values[ring[2]]);
    invert ? emitTriangle(pA,pC,pB):emitTriangle(pA,pB,pC);
    return;
  }

  const p0=inside[0],p1=inside[1],o0=outside[0],o1=outside[1];
  const a = interpolate(points[p0], points[o0], values[p0], values[o0]);
  const b = interpolate(points[p0], points[o1], values[p0], values[o1]);
  const c = interpolate(points[p1], points[o0], values[p1], values[o0]);
  const d = interpolate(points[p1], points[o1], values[p1], values[o1]);
  emitTriangle(a,c,b);
  emitTriangle(b,c,d);
}

function buildChunkMesh(chunk,scene){
  const positions=[],indices=[];
  for(let z=chunk.minCell.z; z<chunk.maxCell.z; z++){
    for(let y=chunk.minCell.y; y<chunk.maxCell.y; y++){
      for(let x=chunk.minCell.x; x<chunk.maxCell.x; x++){
        const cubePoints=cornerOffsets.map(([ox,oy,oz])=>new BABYLON.Vector3((x+ox)*CELL_SIZE,(y+oy)*CELL_SIZE,(z+oz)*CELL_SIZE));
        const cubeValues=cornerOffsets.map(([ox,oy,oz])=>field[getIndex(x+ox,y+oy,z+oz)]);
        for(const tet of tetrahedra){
          const tPoints=tet.map(i=>cubePoints[i]);
          const tValues=tet.map(i=>cubeValues[i]);
          polygonizeTetra(tPoints,tValues,positions,indices);
        }
      }
    }
  }

  if(indices.length===0){
    chunk.mesh.setEnabled(false);
    chunk.triangleCount=0;
    return;
  }

  const normals=[];
  BABYLON.VertexData.ComputeNormals(positions,indices,normals);

  const uvs=[],colors=[];
  for(let i=0;i<positions.length;i+=3){
    const px=positions[i],py=positions[i+1],pz=positions[i+2];
    uvs.push(px*0.07,pz*0.07);
    if(py/FIELD_SIZE.y>0.62) colors.push(0.36,0.75,0.39,1);
    else if(py/FIELD_SIZE.y>0.44) colors.push(0.53,0.4,0.28,1);
    else colors.push(0.24,0.25,0.3,1);
  }

  const vd=new BABYLON.VertexData();
  vd.positions=positions; vd.indices=indices; vd.normals=normals; vd.uvs=uvs; vd.colors=colors;
  vd.applyToMesh(chunk.mesh,true);
  chunk.mesh.setEnabled(true);
  chunk.mesh.isPickable=true;
  chunk.mesh.receiveShadows=false;
  chunk.triangleCount=indices.length/3;
}

/* ================================
   CHUNK CREATION + REBUILD
================================ */

function createChunks(scene, material){
  for(let cz=0;cz<chunkCounts.z;cz++){
    for(let cy=0;cy<chunkCounts.y;cy++){
      for(let cx=0;cx<chunkCounts.x;cx++){
        const minCell={x:cx*CHUNK_SIZE,y:cy*CHUNK_SIZE,z:cz*CHUNK_SIZE};
        const maxCell={x:Math.min((cx+1)*CHUNK_SIZE,FIELD_SIZE.x-1),y:Math.min((cy+1)*CHUNK_SIZE,FIELD_SIZE.y-1),z:Math.min((cz+1)*CHUNK_SIZE,FIELD_SIZE.z-1)};
        const mesh = new BABYLON.Mesh(`terrain-${cx}-${cy}-${cz}`,scene);
        mesh.material=material;
        mesh.metadata={terrainChunk:true,key:chunkKey(cx,cy,cz)};
        chunks.set(chunkKey(cx,cy,cz),{key:chunkKey(cx,cy,cz),minCell,maxCell,mesh,triangleCount:0});
      }
    }
  }
}

function rebuildDirtyChunks(scene,maxPerFrame=Infinity){
  let built=0;
  for(const key of dirtyChunks){
    const chunk=chunks.get(key);
    if(!chunk) continue;
    buildChunkMesh(chunk,scene);
    dirtyChunks.delete(key);
    built++;
    if(built>=maxPerFrame) break;
  }
}

function markAllChunksDirty(){
  chunks.forEach((_,key)=>dirtyChunks.add(key));
}

/* ================================
   TEXTURE
================================ */

function createGroundTexture(scene){
  const tex = new BABYLON.DynamicTexture("groundTex",{width:256,height:256},scene,false);
  const ctx=tex.getContext();
  ctx.fillStyle="#8d7a64"; ctx.fillRect(0,0,256,256);
  for(let i=0;i<3200;i++){
    const x=Math.random()*256,y=Math.random()*256,shade=105+Math.random()*55;
    ctx.fillStyle=`rgba(${shade},${shade*0.9},${shade*0.75},0.25)`; ctx.fillRect(x,y,2,2);
  }
  for(let i=0;i<350;i++){
    const x=Math.random()*256,y=Math.random()*256,r=1+Math.random()*2;
    ctx.fillStyle="rgba(75,62,48,0.35)"; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
  }
  tex.update(false);
  tex.wrapU=BABYLON.Texture.WRAP_ADDRESSMODE; tex.wrapV=BABYLON.Texture.WRAP_ADDRESSMODE; tex.anisotropicFilteringLevel=8;
  return tex;
}

/* ================================
   SCENE
================================ */

async function createScene(){
  const scene=new BABYLON.Scene(engine);
  scene.clearColor=new BABYLON.Color4(0.53,0.74,0.93,1);
  scene.fogMode=BABYLON.Scene.FOGMODE_EXP; scene.fogDensity=0.008; scene.fogColor=new BABYLON.Color3(0.5,0.7,0.92);

  const camera = new BABYLON.UniversalCamera("cam",new BABYLON.Vector3(FIELD_SIZE.x*0.5,FIELD_SIZE.y*0.75,FIELD_SIZE.z*0.5),scene);
  camera.setTarget(new BABYLON.Vector3(FIELD_SIZE.x*0.5,FIELD_SIZE.y*0.45,FIELD_SIZE.z*0.6));
  camera.minZ=0.1; camera.maxZ=200; camera.speed=0; camera.inertia=0;
  camera.attachControl(canvas,true);

  const hemi=new BABYLON.HemisphericLight("hemi",new BABYLON.Vector3(0.2,1,0.1),scene); hemi.intensity=0.55;
  const sun=new BABYLON.DirectionalLight("sun",new BABYLON.Vector3(-0.4,-1,0.2),scene); sun.position=new BABYLON.Vector3(70,100,-40); sun.intensity=0.8;

  const terrainMaterial = new BABYLON.StandardMaterial("terrainMat",scene);
  terrainMaterial.specularColor=new BABYLON.Color3(0.04,0.04,0.04);
  terrainMaterial.ambientColor=new BABYLON.Color3(0.45,0.45,0.45);
  terrainMaterial.useVertexColor=true; terrainMaterial.diffuseTexture=createGroundTexture(scene);
  terrainMaterial.diffuseTexture.level=0.9; terrainMaterial.backFaceCulling=false; terrainMaterial.twoSidedLighting=true;

  const sky = BABYLON.MeshBuilder.CreateSphere("sky",{diameter:500,sideOrientation:BABYLON.Mesh.BACKSIDE},scene);
  const skyMat = new BABYLON.StandardMaterial("skyMat",scene);
  skyMat.disableLighting=true; skyMat.emissiveColor=new BABYLON.Color3(0.42,0.66,0.95); sky.material=skyMat;

  const player = {position:new BABYLON.Vector3(FIELD_SIZE.x*0.5,FIELD_SIZE.y*0.7,FIELD_SIZE.z*0.5),velocity:new BABYLON.Vector3(0,0,0),grounded:false,groundNormal:new BABYLON.Vector3(0,1,0)};

  createChunks(scene,terrainMaterial);
  regenerateField();
  markAllChunksDirty();

  engine.runRenderLoop(()=>{
    rebuildDirtyChunks(scene,2);

    const dt = engine.getDeltaTime()/1000;

    /* ---------------------
       PLAYER INPUT
    --------------------- */
    let moveDir = new BABYLON.Vector3(0,0,0);
    if(pressed.has("w")) moveDir.z+=1;
    if(pressed.has("s")) moveDir.z-=1;
    if(pressed.has("a")) moveDir.x-=1;
    if(pressed.has("d")) moveDir.x+=1;

    if(moveDir.length()>0) moveDir.normalize();

    const yaw = camera.rotation.y;
    const f = new BABYLON.Vector3(Math.sin(yaw),0,Math.cos(yaw));
    const r = new BABYLON.Vector3(f.z,0,-f.x);
    let inputVec = f.scale(moveDir.z).add(r.scale(moveDir.x));
    inputVec.normalize();

    const accel = player.grounded ? MOVE_ACCEL : MOVE_ACCEL*AIR_CONTROL;
    player.velocity.x += inputVec.x*accel*dt;
    player.velocity.z += inputVec.z*accel*dt;

    const friction = player.grounded ? MOVE_FRICTION : MOVE_FRICTION*0.2;
    player.velocity.x -= player.velocity.x*Math.min(1,friction*dt);
    player.velocity.z -= player.velocity.z*Math.min(1,friction*dt);

    player.velocity.x = clamp(player.velocity.x,-MAX_SPEED,MAX_SPEED);
    player.velocity.z = clamp(player.velocity.z,-MAX_SPEED,MAX_SPEED);

    /* ---------------------
       VERTICAL + GROUND STICK
    --------------------- */
    const groundInfo = getGroundInfo(player.position);

    if(groundInfo){
      const desiredY = groundInfo.y + PLAYER_HALF_HEIGHT + PLAYER_CLEARANCE;
      const slopeDot = groundInfo.normal.dot(BABYLON.Vector3.Up());
      const nearGround = player.position.y <= desiredY + 0.08;

      if(slopeDot > MAX_SLOPE_DOT && player.velocity.y <=0 && nearGround){
        player.position.y = desiredY;
        player.velocity.y = 0;
        player.grounded = true;
        player.groundNormal = groundInfo.normal;
      } else {
        player.grounded = false;
      }
    } else player.grounded=false;

    if(!player.grounded){
      player.velocity.y -= GRAVITY*dt;
      player.velocity.y = Math.max(player.velocity.y,-30);
      player.position.y += player.velocity.y*dt;
    }

    if(pressed.has(" ") && player.grounded){
      player.velocity.y = JUMP_FORCE;
      player.grounded=false;
    }

    /* ---------------------
       MOVE + COLLISION XZ
    --------------------- */
    const nextPos = player.position.add(new BABYLON.Vector3(player.velocity.x*dt,0,player.velocity.z*dt));
    if(!collidesAt(nextPos)) player.position.xz = nextPos.xz;

    /* ---------------------
       CAMERA
    --------------------- */
    camera.position.copyFrom(player.position);
    camera.position.y += PLAYER_EYE_HEIGHT;

    scene.render();
  });

  return scene;
}

/* ================================
   INPUT
================================ */

window.addEventListener("keydown",e=>pressed.add(e.key.toLowerCase()));
window.addEventListener("keyup",e=>pressed.delete(e.key.toLowerCase()));

regenerateField();
createScene();
