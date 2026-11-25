// Draw on demand. Pointer movement bends the lattice and releases it back into place.
function mountMesh(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const radius = 106;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let width, height, frame = 0, strength = 0, target = 0;
  let x = 0, y = 0, aimX = 0, aimY = 0;
  function schedule() {
    if (!frame && !document.hidden) frame = requestAnimationFrame(draw);
  }
  function draw() {
    frame = 0;
    x += (aimX - x) * .28;
    y += (aimY - y) * .28;
    strength += (target - strength) * .16;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(140,106,207,.24)";
    if (strength > .01) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, "rgba(99,255,241," + strength + ")");
      glow.addColorStop(.52, "rgba(246,92,208," + (.78 * strength) + ")");
      glow.addColorStop(1, "rgba(140,106,207,.24)");
      ctx.strokeStyle = glow;
    }
    ctx.beginPath();
    function vertex(px, py, first) {
      const dx = px - x, dy = py - y;
      const influence = Math.max(0, 1 - (dx * dx + dy * dy) / (radius * radius));
      const warp = influence * influence * strength * .65;
      if (first) ctx.moveTo(px + dx * warp, py + dy * warp);
      else ctx.lineTo(px + dx * warp, py + dy * warp);
    }
    for (let col = 0; col <= width; col += 40) {
      for (let row = 0; row <= height + 10; row += 10) vertex(col, row, row === 0);
    }
    for (let row = 0; row <= height; row += 40) {
      for (let col = 0; col <= width + 10; col += 10) vertex(col, row, col === 0);
    }
    ctx.stroke();
    if (Math.abs(strength - target) > .002 || Math.abs(x - aimX) + Math.abs(y - aimY) > .5) {
      schedule();
    }
  }
  function resize() {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    const scale = Math.min(devicePixelRatio, 1.5);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    schedule();
  }
  function release() {
    target = 0;
    schedule();
  }
  window.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch" || reduced.matches) return;
    aimX = event.clientX;
    aimY = event.clientY;
    if (strength < .01) {
      x = aimX;
      y = aimY;
    }
    target = 1;
    schedule();
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", release);
  window.addEventListener("blur", release);
  reduced.addEventListener("change", () => {
    strength = 0;
    release();
  });
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) resize();
  });
  resize();
}
mountMesh(document.getElementById("mesh"));
