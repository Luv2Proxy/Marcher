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
