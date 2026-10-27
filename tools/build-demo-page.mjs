/**
 * Build the demo video's page, and record it.
 *
 *   node tools/build-demo-page.mjs [--width 1280] [--height 720] [--only-page]
 *
 * Why a page instead of a screen recording: under SwiftShader this machine
 * renders the reconstruction at well under one frame a second, so filming the
 * game produces a slideshow. The stills in artifacts/demo-shots are captured by
 * driving the real game, and this plays them back with motion that the renderer
 * can actually sustain — so the result is smooth, and every frame of it is
 * genuinely the game rather than a mock-up.
 *
 * The timeline is a plain array so the video can be re-cut without touching
 * layout, and the total duration is printed so the report can quote it.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const shotDir = join(root, 'artifacts', 'demo-shots');
const outDir = join(root, 'artifacts', 'demo');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const WIDTH = flag('width', 1280);
const HEIGHT = flag('height', 720);
const onlyPage = args.includes('--only-page');

/**
 * The film.
 *
 * `kind` picks the layout: 'card' is a full-bleed still with a caption band,
 * 'title' is type only, 'split' pairs one still with a block of text. `hold` is
 * seconds on screen.
 */
/**
 * The assertion total, read from the one file that is derived from a real run
 * rather than restated here. It was hand-written in this file and in the slide
 * deck and went stale every time a step was added.
 */
const ASSERTIONS = JSON.parse(readFileSync(join(here, '..', 'data/assertions.json'), 'utf8'));
const assertionLine =
  `${ASSERTIONS.total} 项断言全绿：` +
  ASSERTIONS.steps
    .filter((s) => s.step !== 'test')
    .map((s) => `${s.count} ${s.label}`)
    .concat(`${ASSERTIONS.steps.find((s) => s.step === 'test').count} 单测`)
    .join(' · ') +
  '。';

const SCENES = [
  {
    kind: 'title',
    hold: 5,
    title: 'FOREIGN',
    sub: '异物',
    line: '一间真实的房间。里面有些东西，本不该在这里。',
  },
  {
    kind: 'card',
    hold: 8,
    img: '02-room.png',
    tag: '重建空间',
    title: '房间是扫描来的，不是我搭的',
    body: '整个空间由 3DGS 高斯泼溅重建 —— Aholo 官方开源室内场景，63 MB 的 .spz。走进去、撞到墙、被家具挡住，全部由体素碰撞驱动。',
  },
  {
    kind: 'text',
    hold: 9,
    tag: '最初的问题',
    title: '「这东西该不该在这儿？」—— 原本没有答案',
    points: [
      '旁观物件和异常，原来是从同一份荒诞生成目录里抽的。',
      '橡皮鸭、交通锥、地精、宇航员 —— 无辜的和有罪的，看起来是同一类东西。',
      '于是判断没有真值，『多出来一个东西』这个类型甚至因为无法判断而被删掉了。',
    ],
  },
  {
    kind: 'card',
    hold: 8,
    img: '03-furniture.png',
    tag: '修法',
    title: '先给房间一个「正常」',
    body: '13 个家务家具 —— 盆栽、垃圾桶、椅子、落地灯、水壶…… 全部离线生成为扁平着色的 GLB，十三个加起来 83 KB，比原来一张 2048×2048 贴图还小。它们什么都不做。',
  },
  {
    kind: 'card',
    hold: 8,
    img: '04-intruder.png',
    tag: '判断一 · 它不该存在',
    title: '生成物 = 入侵者',
    body: '只有 intrude 这一类用 Lux3D 生成的怪东西。房间里的家具永远无辜，生成的物体永远不是家具 —— 两个集合不许相交，「该不该在这儿」于是有了唯一答案。',
  },
  {
    kind: 'card',
    hold: 8,
    img: '05-inverted.png',
    tag: '判断二 · 它不该这样',
    title: '家具做了家具不该做的事',
    body: '倒挂、浮空、巨大、变色、成堆 —— 行为类异常用的同样是家务家具。因为行为只有在「正常」的对照下才读得出来：一把倒挂的椅子，在一屋子椅子中间才叫诡异。',
  },
  {
    kind: 'card',
    hold: 7,
    img: '06-swarm.png',
    tag: '判断二 · 继续',
    title: '多到数不清',
    body: '同一个东西出现十几个，散落成一群。这时候已经没人会去数了 —— 那正是重点。',
  },
  {
    kind: 'card',
    hold: 9,
    img: '07-torch.png',
    tag: '恐怖',
    title: '一层比一层黑，手电筒越走越短',
    body: '黑暗从 0.18 逐层加到 0.86，手电筒半径从屏幕短边的 0.62 缩到 0.26，闪烁一次比一次凶。第 8 层是最底层 —— 通关在那里。',
  },
  {
    kind: 'card',
    hold: 5,
    img: '08-scare.png',
    tag: '恐吓',
    title: '它会在你背后出现',
    body: '每个隔 9–60 秒（越深越密）在你视野边缘炸开一张脸，配一层噪声爆裂和下滑的锯齿低频。第一次误判也会触发 —— 惩罚不是扣分，是吓你。',
  },
  {
    kind: 'card',
    hold: 7,
    img: '09-marked.png',
    tag: '玩法',
    title: '打中不罚，打错才罚',
    body: '每层三次误判额度，用完这一层就结束；标记对了不扣任何东西，所以没有「该不该开枪」，只有「看没看清」。第一层只放一个异常，教你看什么叫做「不该在这儿」。',
  },
  {
    kind: 'text',
    hold: 9,
    tag: '技术',
    title: '全部由 Aholo 驱动，每一步都被验收',
    points: [
      'Lux3D 文生 3D：14 个异物由文字生成，再加 13 件写实家具与 7 个程序化占位，共 34 个资产、10,602,848 字节。',
      '3DGS 高斯泼溅：场景加载、体素碰撞、第一人称行走。',
      assertionLine,
      '无头 Chromium 真机跑验收，不是「我看过了」。',
    ],
  },
  {
    kind: 'title',
    hold: 5,
    title: '异物',
    sub: 'FOREIGN',
    line: 'cyn-nya.github.io/foreign',
  },
];

const total = SCENES.reduce((sum, s) => sum + s.hold, 0);
console.log(`${SCENES.length} scenes, ${total}s`);

// --- collect the stills that actually exist ---------------------------------
if (!existsSync(shotDir)) {
  console.error('artifacts/demo-shots is missing — run `node tools/capture-demo.mjs` first.');
  process.exit(1);
}
const available = new Set(readdirSync(shotDir).filter((f) => f.endsWith('.png')));
const missing = [];
for (const scene of SCENES) {
  if (scene.img && !available.has(scene.img)) missing.push(scene.img);
}
if (missing.length) {
  // A missing still would silently render as an empty panel, which is the kind of
  // failure that ships.
  console.error(`missing stills for: ${[...new Set(missing)].join(', ')}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
for (const file of available) copyFileSync(join(shotDir, file), join(outDir, file));

// --- render the page --------------------------------------------------------
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function sceneHtml(scene, index) {
  const cls = `scene s-${scene.kind}`;
  const id = `data-index="${index}"`;

  if (scene.kind === 'title') {
    return `<section class="${cls}" ${id}>
      <div class="title-wrap">
        <h1>${esc(scene.title)}</h1>
        <div class="sub">${esc(scene.sub)}</div>
        <p class="line">${esc(scene.line)}</p>
      </div>
    </section>`;
  }

  if (scene.kind === 'text') {
    const points = scene.points.map((p) => `<li>${esc(p)}</li>`).join('');
    return `<section class="${cls}" ${id}>
      <div class="text-wrap">
        ${scene.tag ? `<div class="tag">${esc(scene.tag)}</div>` : ''}
        <h2>${esc(scene.title)}</h2>
        <ul>${points}</ul>
      </div>
    </section>`;
  }

  return `<section class="${cls}" ${id}>
    <div class="still" style="background-image:url('${esc(scene.img)}')"></div>
    <div class="caption">
      ${scene.tag ? `<div class="tag">${esc(scene.tag)}</div>` : ''}
      <h2>${esc(scene.title)}</h2>
      <p>${esc(scene.body)}</p>
    </div>
  </section>`;
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>FOREIGN / 异物 — demo</title>
<style>
  :root { --ink:#f2efe9; --dim:#a49d92; --bg:#07070a; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:100%; height:100%; overflow:hidden; background:var(--bg); }
  body { font-family:"Microsoft YaHei","PingFang SC","Noto Sans SC",system-ui,sans-serif; color:var(--ink); }

  .scene {
    position:absolute; inset:0; opacity:0;
    transition:opacity 420ms ease;
  }
  .scene.on { opacity:1; }

  /* Ken Burns keeps a still from reading as a dead slide. */
  .scene .still {
    position:absolute; inset:0;
    background-size:cover; background-position:center;
    transform:scale(1.06);
    transition:transform 9s linear;
  }
  .scene.on .still { transform:scale(1.0); }

  .card .caption {
    position:absolute; left:0; right:0; bottom:0;
    padding:46px 64px 44px;
    background:linear-gradient(to top, rgba(4,4,7,.96) 12%, rgba(4,4,7,.82) 55%, rgba(4,4,7,0) 100%);
  }
  .card h2 { font-size:38px; line-height:1.28; margin:12px 0 14px; font-weight:700; letter-spacing:.4px; }
  .card p { font-size:20px; line-height:1.72; color:#ddd7cd; max-width:1020px; }

  .tag {
    display:inline-block; font-size:15px; letter-spacing:3px;
    color:#ff8f6b; border:1px solid rgba(255,143,107,.45);
    border-radius:3px; padding:5px 12px;
  }

  .title-wrap, .text-wrap {
    position:absolute; inset:0; display:flex; flex-direction:column;
    justify-content:center; padding:0 96px;
  }
  .title-wrap { align-items:flex-start; }
  h1 { font-size:132px; letter-spacing:16px; font-weight:800; line-height:1; }
  .sub { font-size:52px; letter-spacing:24px; color:#ff8f6b; margin:22px 0 40px; }
  .line { font-size:23px; color:var(--dim); letter-spacing:1.2px; }
  .text h2, .text-wrap h2 { font-size:40px; line-height:1.34; margin:16px 0 30px; max-width:1080px; }
  .text-wrap ul { list-style:none; }
  .text-wrap li {
    font-size:21px; line-height:1.66; color:#ddd7cd; padding-left:30px;
    position:relative; margin-bottom:16px; max-width:1060px;
  }
  .text-wrap li:before {
    content:''; position:absolute; left:0; top:13px;
    width:9px; height:9px; background:#ff8f6b; border-radius:1px;
  }

  #bar { position:absolute; left:0; bottom:0; height:3px; background:#ff8f6b; width:0; z-index:9; }
</style>
</head>
<body>
${SCENES.map(sceneHtml).join('\n')}
<div id="bar"></div>
<script>
  const HOLD = ${JSON.stringify(SCENES.map((s) => s.hold))};
  const scenes = [...document.querySelectorAll('.scene')];
  const bar = document.getElementById('bar');
  const total = HOLD.reduce((a, b) => a + b, 0);

  // A plain clock, so the recording is deterministic: every scene is shown for
  // exactly the seconds it declares, and the page reports when it is done so the
  // recorder never truncates the ending.
  let index = -1, sceneStart = 0, done = false;
  const t0 = performance.now();

  function frame(now) {
    const elapsed = (now - t0) / 1000;
    bar.style.width = Math.min(100, (elapsed / total) * 100) + '%';

    let acc = 0, want = -1;
    for (let i = 0; i < HOLD.length; i++) {
      acc += HOLD[i];
      if (elapsed < acc) { want = i; break; }
    }
    if (want === -1) { done = true; window.__demoDone = true; }
    if (want !== index) {
      if (index >= 0) scenes[index].classList.remove('on');
      index = want;
      if (want >= 0) scenes[want].classList.add('on');
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.__demo = { total, get index() { return index; }, get done() { return done; } };
</script>
</body>
</html>`;

const pagePath = join(outDir, 'index.html');
writeFileSync(pagePath, html);
console.log(`wrote ${pagePath}`);

if (onlyPage) process.exit(0);

// --- record it --------------------------------------------------------------
const browser = await chromium.launch({ args: ['--disable-gpu-sandbox'] });
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  recordVideo: { dir: join(outDir, 'raw'), size: { width: WIDTH, height: HEIGHT } },
});
const page = await context.newPage();
await page.goto(`file:///${pagePath.replace(/\\/g, '/')}`, { waitUntil: 'load' });
// The first scene has to be fully up before recording means anything.
await page.waitForFunction(() => window.__demo && window.__demo.index === 0, null, { timeout: 30_000 });
await page.waitForFunction(() => window.__demo.done, null, { timeout: (total + 30) * 1000 });
await page.waitForTimeout(600);
await context.close();
await browser.close();

const rawDir = join(outDir, 'raw');
const produced = readdirSync(rawDir).filter((f) => f.endsWith('.webm'));
console.log(`recorded ${produced.length} webm: ${produced.join(', ')}`);
console.log(`-> artifacts/demo/raw/  (${total}s, ${WIDTH}x${HEIGHT})`);
