/* ============================================================
 * Playable Novel Engine · 星空氛围背景
 * 轻量 canvas：闪烁星点 + 偶发流星，尊重 prefers-reduced-motion
 * ============================================================ */
(function () {
  'use strict';

  const canvas = document.getElementById('starfield');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0, H = 0, DPR = 1;
  let stars = [];
  let meteors = [];
  let rafId = null;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    seed();
  }

  function seed() {
    // 星点密度随屏幕面积，移动端适度减少
    const count = Math.min(140, Math.floor((W * H) / 12000));
    stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: 0.4 + Math.random() * 1.3,
        baseAlpha: 0.25 + Math.random() * 0.5,
        twinkleSpeed: 0.008 + Math.random() * 0.02,
        phase: Math.random() * Math.PI * 2,
        hue: Math.random() < 0.18 ? '265' : (Math.random() < 0.5 ? '0' : '220'),
        sat: Math.random() < 0.3 ? '60%' : '0%'
      });
    }
  }

  function spawnMeteor() {
    const fromLeft = Math.random() < 0.5;
    meteors.push({
      x: fromLeft ? -50 : W + 50,
      y: Math.random() * H * 0.4,
      vx: (fromLeft ? 1 : -1) * (5 + Math.random() * 4),
      vy: 2 + Math.random() * 2.5,
      life: 1,
      len: 60 + Math.random() * 60
    });
  }

  let tick = 0;
  function draw() {
    ctx.clearRect(0, 0, W, H);
    tick++;

    // 星点
    for (const s of stars) {
      s.phase += s.twinkleSpeed;
      const alpha = s.baseAlpha * (0.6 + 0.4 * Math.sin(s.phase));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = s.sat === '0%'
        ? `rgba(255, 255, 255, ${alpha})`
        : `hsla(${s.hue}, ${s.sat}, 78%, ${alpha})`;
      ctx.fill();
    }

    // 流星（每 ~7 秒一发）
    if (!reduceMotion && tick % 420 === 0 && meteors.length < 2) spawnMeteor();
    meteors = meteors.filter(m => {
      m.x += m.vx;
      m.y += m.vy;
      m.life -= 0.012;
      if (m.life <= 0 || m.x < -100 || m.x > W + 100) return false;
      const grad = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * m.len / 6, m.y - m.vy * m.len / 6);
      grad.addColorStop(0, `rgba(196, 181, 253, ${0.8 * m.life})`);
      grad.addColorStop(1, 'rgba(196, 181, 253, 0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(m.x - m.vx * m.len / 6, m.y - m.vy * m.len / 6);
      ctx.stroke();
      return true;
    });

    rafId = requestAnimationFrame(draw);
  }

  resize();
  window.addEventListener('resize', () => {
    clearTimeout(window.__sfTimer);
    window.__sfTimer = setTimeout(resize, 150);
  });

  if (reduceMotion) {
    // 静态渲染一帧（无动画）
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = s.sat === '0%' ? `rgba(255,255,255,${s.baseAlpha})` : `hsla(${s.hue}, ${s.sat}, 78%, ${s.baseAlpha})`;
      ctx.fill();
    }
  } else {
    draw();
  }

  // 页面隐藏时暂停动画，省电
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    } else if (!reduceMotion && !rafId) {
      draw();
    }
  });
})();
