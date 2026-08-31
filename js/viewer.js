/* FMEC paper website — interactive mesh viewers.
 *
 * One shared WebGL context renders every viewer through scissored viewports
 * (the three.js "multiple elements" pattern), so 18+ scenes stay well under
 * the browser's context limit.  Each viewer div owns its camera + OrbitControls.
 * Data arrives base64-packed from data/*.js (see tools/export_data.py).
 */
(function () {
  'use strict';

  // Okabe-Ito robot palette + surface tone, identical to make_figures.py
  var ROBOT_COLORS = ['#0072B2', '#D55E00', '#009E73', '#CC79A7',
                      '#E69F00', '#56B4E9', '#9467BD', '#000000',
                      '#999933', '#882255'];
  var MESH_COLOR = 0xd8d4cd;
  var PLAY_MS = 16000;               // one full trajectory replay
  var GALLERY_ZOOM = 0.7;            // gallery meshes framed at 70% size

  function bytes(b64) {
    var s = atob(b64), u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  function f32(b64) { return new Float32Array(bytes(b64).buffer); }
  function u16(b64) { return new Uint16Array(bytes(b64).buffer); }

  var canvas = document.getElementById('gl');
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  } catch (err) {
    document.getElementById('webgl-warn').style.display = 'block';
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  var viewers = [];
  var playing = false, playStart = 0;

  function makeViewer(el, key, cfg) {
    var d = window.FMEC_DATA[key];
    var scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.62));
    var sun = new THREE.DirectionalLight(0xffffff, 0.62);
    sun.position.set(1.5, 0.8, 2.0);
    scene.add(sun);
    var fill = new THREE.DirectionalLight(0xffffff, 0.26);
    fill.position.set(-1.2, -1.5, -0.6);
    scene.add(fill);

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(f32(d.v), 3));
    geo.setIndex(new THREE.BufferAttribute(u16(d.f), 1));
    geo.computeVertexNormals();
    var mat;
    if (cfg.density) {
      var cb = bytes(d.colors), cf = new Float32Array(cb.length);
      for (var i = 0; i < cb.length; i++) cf[i] = cb[i] / 255;
      geo.setAttribute('color', new THREE.BufferAttribute(cf, 3));
      mat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 10,
                                          specular: 0x111111, side: THREE.DoubleSide });
    } else {
      mat = new THREE.MeshPhongMaterial({ color: MESH_COLOR, shininess: 16,
                                          specular: 0x1c1c1c, side: THREE.DoubleSide });
    }
    scene.add(new THREE.Mesh(geo, mat));

    var R = d.radius;
    var agents = [];
    d.trajs.forEach(function (tb, k) {
      var p = f32(tb), pts = [];
      for (var i = 0; i < p.length; i += 3)
        pts.push(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
      var color = new THREE.Color(ROBOT_COLORS[k % ROBOT_COLORS.length]);
      var curve = new THREE.CatmullRomCurve3(pts);
      var segs = Math.min(2 * pts.length, 900), radial = 6;
      var tubeGeo = new THREE.TubeGeometry(curve, segs, 0.0052 * R, radial, false);
      var lineMat = new THREE.MeshLambertMaterial({
        color: color.clone().multiplyScalar(0.62),
        emissive: color.clone().multiplyScalar(0.5)
      });
      var tube = new THREE.Mesh(tubeGeo, lineMat);
      scene.add(tube);
      var dotMat = new THREE.MeshBasicMaterial({ color: color });
      var start = new THREE.Mesh(new THREE.SphereGeometry(0.015 * R, 14, 10), dotMat);
      start.position.copy(pts[0]);
      scene.add(start);
      var head = new THREE.Mesh(new THREE.SphereGeometry(0.021 * R, 14, 10), dotMat);
      head.visible = false;
      scene.add(head);
      agents.push({ tube: tube, curve: curve, segs: segs, radial: radial, head: head });
    });

    var camera = new THREE.PerspectiveCamera(40, 1, R * 0.01, R * 60);
    camera.up.set(0, 0, 1);
    var D = 1.35 * R / (cfg.zoom || 1), e = cfg.cam;
    camera.position.set(e[0] * D, e[1] * D, e[2] * D);

    var controls = new THREE.OrbitControls(camera, el);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.rotateSpeed = 0.85;
    controls.target.set(0, 0, 0);
    if (cfg.autorotate) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.8;
      el.addEventListener('pointerdown', function () { controls.autoRotate = false; },
                          { once: true });
    }

    var v = { el: el, scene: scene, camera: camera, controls: controls,
              agents: agents, home: camera.position.clone() };
    el.addEventListener('dblclick', function () { resetView(v); });
    viewers.push(v);
    return v;
  }

  function resetView(v) {
    v.controls.target.set(0, 0, 0);
    v.camera.position.copy(v.home);
    v.controls.update();
  }

  function setPlaying(p) {
    playing = p;
    playStart = performance.now();
    var b = document.getElementById('btn-play');
    b.textContent = p ? '⏸ Pause trajectories' : '▶ Replay trajectories';
    b.classList.toggle('active', p);
    if (!p) {
      viewers.forEach(function (v) {
        v.agents.forEach(function (a) {
          a.tube.geometry.setDrawRange(0, Infinity);
          a.head.visible = false;
        });
      });
    }
  }

  function card(m, cfg, parent) {
    var el = document.createElement('div');
    el.className = 'card';
    el.innerHTML =
      '<div class="card-head"><span class="mesh-name">' + m.name + '</span>' +
      '<span class="badges"><span class="badge">N = ' + m.n + '</span>' +
      '</span></div>' +
      '<div class="viewport"></div>';
    parent.appendChild(el);
    makeViewer(el.querySelector('.viewport'), m.key,
               { cam: m.cam, density: cfg.density, zoom: cfg.zoom });
  }

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  function render(t) {
    requestAnimationFrame(render);
    if (playing) {
      var frac = ((t - playStart) % PLAY_MS) / PLAY_MS;
      viewers.forEach(function (v) {
        v.agents.forEach(function (a) {
          var s = Math.max(1, Math.round(frac * a.segs));
          a.tube.geometry.setDrawRange(0, s * a.radial * 6);
          a.head.visible = true;
          a.head.position.copy(a.curve.getPointAt(Math.min(s / a.segs, 1)));
        });
      });
    }
    var cw = canvas.clientWidth, ch = canvas.clientHeight;
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    viewers.forEach(function (v) {
      var r = v.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > ch || r.right < 0 || r.left > cw) return;
      v.controls.update();
      var bottom = ch - r.bottom;
      renderer.setViewport(r.left, bottom, r.width, r.height);
      renderer.setScissor(r.left, bottom, r.width, r.height);
      v.camera.aspect = r.width / r.height;
      v.camera.updateProjectionMatrix();
      renderer.render(v.scene, v.camera);
    });
  }

  // ---- build the page ----
  var M = window.FMEC_MANIFEST;
  makeViewer(document.getElementById('hero-view'), M.hero.key,
             { cam: M.hero.cam, density: false, autorotate: true });
  var g = document.getElementById('gallery-grid');
  M.gallery.forEach(function (m) { card(m, { density: false, zoom: GALLERY_ZOOM }, g); });
  var l = document.getElementById('landmark-grid');
  M.landmarks.forEach(function (m) { card(m, { density: true }, l); });

  document.getElementById('btn-play').addEventListener('click', function () {
    setPlaying(!playing);
  });
  document.getElementById('btn-reset').addEventListener('click', function () {
    viewers.forEach(resetView);
  });
  window.addEventListener('resize', resize);
  resize();
  setPlaying(true);                  // trajectories replay by default
  requestAnimationFrame(render);
})();
