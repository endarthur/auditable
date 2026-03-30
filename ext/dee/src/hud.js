// @gcu/dee — HUD overlays: north arrow, scale bar, coordinate readout, axes, bounding box

export function createHUD(dee) {
  const THREE = dee.THREE;
  const container = dee.renderer.domElement.parentElement;

  return {
    northArrow(opts = {}) {
      const size = opts.size || 60;
      const pos = opts.position || 'top-right';
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;${pos === 'top-right' ? 'top:10px;right:10px' : 'top:10px;left:10px'};width:${size}px;height:${size}px;pointer-events:none;z-index:10;`;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('width', size); svg.setAttribute('height', size);
      svg.innerHTML = `<polygon points="50,10 40,60 50,50 60,60" fill="#c89b3c" stroke="#888" stroke-width="1"/>
        <text x="50" y="8" text-anchor="middle" fill="#ccc" font-size="14" font-family="monospace">N</text>`;
      el.appendChild(svg);
      container.appendChild(el);

      // update rotation on render
      dee.onAfterRender(() => {
        const cam = dee.camera;
        const dir = new THREE.Vector3();
        cam.getWorldDirection(dir);
        const angle = Math.atan2(dir.x, dir.y) * 180 / Math.PI;
        svg.style.transform = `rotate(${angle}deg)`;
      });

      return { element: el, dispose() { el.remove(); } };
    },

    scaleBar(opts = {}) {
      const pos = opts.position || 'bottom-left';
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;${pos === 'bottom-left' ? 'bottom:10px;left:10px' : 'bottom:10px;right:10px'};z-index:10;pointer-events:none;font:11px monospace;color:#ccc;`;
      const barEl = document.createElement('div');
      barEl.style.cssText = 'border:1px solid #ccc;border-top:none;height:6px;width:100px;';
      const labelEl = document.createElement('div');
      labelEl.style.cssText = 'text-align:center;margin-top:2px;';
      el.appendChild(barEl);
      el.appendChild(labelEl);
      container.appendChild(el);

      dee.onAfterRender(() => {
        const cam = dee.camera;
        const w = dee.renderer.domElement.clientWidth;
        // approximate world units per pixel
        const dist = cam.position.distanceTo(dee.controls._controls.target);
        const vFov = cam.fov * Math.PI / 180;
        const worldH = 2 * dist * Math.tan(vFov / 2);
        const worldPerPx = worldH / dee.renderer.domElement.clientHeight;
        const targetPx = 100;
        const worldLen = worldPerPx * targetPx;
        // round to nice number
        const mag = Math.pow(10, Math.floor(Math.log10(worldLen)));
        const nice = worldLen / mag >= 5 ? 5 * mag : worldLen / mag >= 2 ? 2 * mag : mag;
        const barPx = nice / worldPerPx;
        barEl.style.width = `${barPx}px`;
        labelEl.textContent = nice >= 1000 ? `${(nice / 1000).toFixed(1)} km` : `${nice.toFixed(0)} m`;
      });

      return { element: el, dispose() { el.remove(); } };
    },

    coordReadout(opts = {}) {
      const pos = opts.position || 'bottom-right';
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;${pos === 'bottom-right' ? 'bottom:10px;right:10px' : 'bottom:10px;left:120px'};z-index:10;pointer-events:none;font:11px monospace;color:#999;`;
      container.appendChild(el);

      dee.pick.on('hover', (result) => {
        if (!result || !result.worldPosition) { el.textContent = ''; return; }
        const [x, y, z] = result.worldPosition;
        el.textContent = `E: ${x.toFixed(1)}  N: ${y.toFixed(1)}  Z: ${z.toFixed(1)}`;
      });

      return { element: el, dispose() { el.remove(); } };
    },

    axes(opts = {}) {
      const length = opts.length || 100;
      const labels = opts.labels || ['E', 'N', 'Z'];
      const group = new THREE.Group();
      group.name = '_hud_axes';

      const colors = [0xff4444, 0x44ff44, 0x4444ff];
      for (let i = 0; i < 3; i++) {
        const dir = [0, 0, 0]; dir[i] = length;
        const geom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(dir[0], dir[1], dir[2]),
        ]);
        const mat = new THREE.LineBasicMaterial({ color: colors[i] });
        group.add(new THREE.Line(geom, mat));
      }

      dee.scene.add(group);
      dee.markDirty();
      return { group, dispose() { group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); dee.scene.remove(group); } };
    },

    boundingBox(gridDefOrBounds) {
      let min, max;
      if (gridDefOrBounds.min && gridDefOrBounds.max) {
        min = gridDefOrBounds.min; max = gridDefOrBounds.max;
      } else {
        // assume grid definition — import not available here, compute manually
        const g = gridDefOrBounds;
        const nx = g.count[0] - 1, ny = g.count[1] - 1, nz = g.count[2] - 1;
        const hx = g.size[0] / 2, hy = g.size[1] / 2, hz = g.size[2] / 2;
        min = [g.origin[0] - hx, g.origin[1] - hy, g.origin[2] - hz];
        max = [g.origin[0] + nx * g.size[0] + hx, g.origin[1] + ny * g.size[1] + hy, g.origin[2] + nz * g.size[2] + hz];
      }
      const ox = dee.origin[0], oy = dee.origin[1], oz = dee.origin[2];
      const box = new THREE.Box3(
        new THREE.Vector3(min[0] - ox, min[1] - oy, min[2] - oz),
        new THREE.Vector3(max[0] - ox, max[1] - oy, max[2] - oz),
      );
      const helper = new THREE.Box3Helper(box, 0x888888);
      helper.name = '_hud_bbox';
      dee.scene.add(helper);
      dee.markDirty();
      return { helper, dispose() { dee.scene.remove(helper); } };
    },
  };
}
