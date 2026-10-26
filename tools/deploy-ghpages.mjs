/**
 * Publish the built demo to GitHub Pages.
 *
 *   node tools/deploy-ghpages.mjs [--remote origin] [--branch gh-pages]
 *
 * Publishes from a `gh-pages` branch rather than a GitHub Actions workflow,
 * because GitHub refuses to let an OAuth app push to `.github/workflows/`
 * without the `workflow` token scope. Branch publishing needs only `repo`.
 *
 * The work is done in a throwaway directory so the main working tree is never
 * switched, stashed, or left on another branch — a deploy that can lose your
 * uncommitted work is not a deploy you run casually.
 *
 * `npm run deploy:check` runs first and refuses to publish a build that does not
 * work under a sub-path, which is the one way a local build passes and a Pages
 * site breaks.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const remote = arg('remote', 'origin');
const branch = arg('branch', 'gh-pages');

function run(command, options = {}) {
  const result = spawnSync(command, { shell: true, cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) {
    console.error(`$ ${command}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    process.exit(result.status ?? 1);
  }
  return (result.stdout ?? '').trim();
}

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/index.html is missing — run `npm run build` first.');
  process.exit(1);
}

const url = run(`git remote get-url ${remote}`);
if (!url) {
  console.error(`no git remote named ${remote}`);
  process.exit(1);
}
console.log(`publishing dist/ to ${url} (${branch})`);

// Never publish a build that has not been proven to work under a sub-path.
console.log('\n--- deploy:check ---');
const check = spawnSync('node', ['tools/check-deploy.mjs'], {
  shell: true,
  cwd: root,
  stdio: 'inherit',
});
if (check.status !== 0) {
  console.error('\ndeploy:check failed — refusing to publish.');
  process.exit(check.status ?? 1);
}

const staging = join(resolve(root, '..'), '.foreign-pages-publish');
rmSync(staging, { recursive: true, force: true });
copyTree(dist, staging);

// Without this, Pages runs the output through Jekyll, which drops files and
// directories beginning with an underscore.
writeFileSync(join(staging, '.nojekyll'), '');

// `--oneline`, not `--pretty=%h %s`: these run through cmd.exe, which treats
// `%s` as a variable reference and hands git a stray argument instead.
const stamp = run('git log -1 --oneline');
const steps = [
  'git init -q',
  `git checkout -q -b ${branch}`,
  'git add -A',
  `git -c user.name=deploy -c user.email=deploy@localhost commit -q -m ${JSON.stringify(`Publish demo from ${stamp}`)}`,
  `git push -q -f ${JSON.stringify(url)} ${branch}`,
];
for (const step of steps) {
  run(step, { cwd: staging });
}
rmSync(staging, { recursive: true, force: true });

console.log(`\npushed ${branch}.`);
console.log('If this is the first publish, enable Pages once:');
console.log('  gh api -X POST repos/<owner>/<repo>/pages --input pages.json');
console.log('with {"source":{"branch":"gh-pages","path":"/"}}');
