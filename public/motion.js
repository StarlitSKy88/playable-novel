/* ============================================================
 * motion.js · 首屏入场时间线
 * ------------------------------------------------------------
 * 一条 Web Animations 时间轴，只跑一次：
 *   顶栏 / 步骤条 drop → kicker、两行标题 blur 弹起（间隔 0.16s）
 *   → subline、双 CTA、三张特性卡、上传区、侧边栏依次 rise
 * prefers-reduced-motion: reduce 时整体跳过，元素直接落到终态。
 * ========================================================== */
(function () {
  'use strict';

  var reduce = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

  /* 三种入场变体 */
  var VARIANTS = {
    drop: {
      duration: 520,
      frames: [
        { opacity: 0, transform: 'translateY(-14px)' },
        { opacity: 1, transform: 'none' }
      ]
    },
    /* 从模糊里弹出来 —— 对应 headline "springs up out of a blur" */
    blur: {
      duration: 760,
      frames: [
        { opacity: 0, transform: 'translateY(26px)', filter: 'blur(12px)' },
        { opacity: 1, transform: 'none', filter: 'blur(0px)' }
      ]
    },
    rise: {
      duration: 620,
      frames: [
        { opacity: 0, transform: 'translateY(16px)' },
        { opacity: 1, transform: 'none' }
      ]
    }
  };

  /* [选择器, 变体, 起始延迟, 同组错峰] */
  var SEQUENCE = [
    ['.brand',                               'drop',    0,   0],
    ['.topbar-actions',                      'drop',   60,   0],
    ['.step-bar',                            'drop',  130,   0],
    ['.hero-kicker',                         'blur',  240,   0],
    ['.hero-headline .hl-line:nth-child(1)', 'blur',  320,   0],
    ['.hero-headline .hl-line:nth-child(2)', 'blur',  480,   0],
    ['.hero-subline',                        'rise',  660,   0],
    ['.hero-btn',                            'rise',  800,  60],
    ['.hero-feature',                        'rise',  950,  70],
    ['#dropzone',                            'rise', 1180,   0],
    ['.side-block',                          'rise', 1250,  40]
  ];

  function eachNode(fn) {
    SEQUENCE.forEach(function (item) {
      Array.prototype.forEach.call(document.querySelectorAll(item[0]), function (el, i) {
        fn(el, item, i);
      });
    });
  }

  /* 同步置透明，杜绝时间线创建前的一帧闪现；结束后再还原 */
  function preHide() {
    eachNode(function (el) { el.style.opacity = '0'; });
  }
  /* 还原时临时掐断 transition：否则带 transition:all 的元素（如 .dropzone）
     会从 0 再淡入一次，和入场动画叠成二次动画 */
  function unHide() {
    eachNode(function (el) {
      el.style.transition = 'none';
      el.style.opacity = '';
      void el.offsetHeight;               // 强制回流，让 none 生效
      el.style.transition = '';
    });
  }

  function endBoot() {
    unHide();
    document.body.classList.remove('booting');
  }

  function play() {
    var pending = [];
    eachNode(function (el, item, i) {
      var variant = VARIANTS[item[1]];
      var anim = el.animate(variant.frames, {
        duration: variant.duration,
        delay: item[2] + i * item[3],
        easing: EASE,
        fill: 'backwards'   // 延迟期间保持首帧
      });
      pending.push(anim.finished);
    });

    if (!pending.length) { endBoot(); return; }
    Promise.all(pending).then(endBoot, endBoot);
  }

  /* ---------- Hero CTA 接线 ---------- */
  function wireHero() {
    var start = document.getElementById('heroStart');
    var demo = document.getElementById('heroDemo');
    var dz = document.getElementById('dropzone');

    if (start && dz) {
      start.addEventListener('click', function () {
        dz.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
        dz.classList.remove('dz-pulse');
        void dz.offsetWidth;               // 重置动画
        dz.classList.add('dz-pulse');
        setTimeout(function () { dz.classList.remove('dz-pulse'); }, 950);
      });
    }
    if (demo) {
      demo.addEventListener('click', function () {
        var b = document.getElementById('btnSample');
        if (b) b.click();
      });
    }
  }

  function boot() {
    wireHero();
    if (reduce || !document.body.classList.contains('booting')) { endBoot(); return; }
    preHide();
    /* 等一帧让布局稳定，再挂时间线 */
    requestAnimationFrame(function () { requestAnimationFrame(play); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
