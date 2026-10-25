import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist');
const name = 'cnb2api-panel';
// Release overlays can leave an older web/src and lockfile on the host.
// Exclude both from the release build context so Docker uses this package's dist.
const releaseDockerignore = [
  '**',
  '!package.json',
  '!src/',
  '!src/*.mjs',
  '!web/',
  '!web/dist/',
  '!web/dist/**',
  '',
].join('\n');
let staging;

try {
  const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const releaseTag = process.env.RELEASE_TAG;
  if (releaseTag && releaseTag !== `v${project.version}`)
    throw new Error(`Release tag ${releaseTag} must match package version v${project.version}`);
  const builtAt = new Date().toISOString();
  const date = builtAt.slice(0, 10).replaceAll('-', '');
  const archive = `${name}-v${project.version}-${date}.tar.gz`;
  if (!existsSync(join(root, 'web/dist/index.html')))
    throw new Error('Build the console first: npm run package');
  mkdirSync(output, { recursive: true });
  staging = mkdtempSync(join(output, '.panel-package-'));
  const destination = join(staging, name);
  mkdirSync(destination);

  for (const file of ['LICENSE', 'README.md', 'Dockerfile', 'docker-compose.yaml', 'docker-compose.build.yaml', '.env.example', 'nginx.conf'])
    copyFileSync(join(root, file), join(destination, file));
  writeFileSync(join(destination, '.dockerignore'), releaseDockerignore);
  cpSync(join(root, 'src'), join(destination, 'src'), { recursive: true });
  cpSync(join(root, 'web/dist'), join(destination, 'web/dist'), { recursive: true });

  writeFileSync(join(destination, 'package.json'), `${JSON.stringify({
    name: project.name,
    version: project.version,
    private: true,
    description: project.description,
    type: project.type,
    engines: project.engines,
    scripts: { start: project.scripts.start },
    license: project.license,
  }, null, 2)}\n`);
  writeFileSync(join(destination, 'build-info.json'), `${JSON.stringify({
    name: project.name,
    version: project.version,
    builtAt,
  }, null, 2)}\n`);

  const result = spawnSync('tar', ['-czf', join(staging, archive), '-C', staging, name], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar exited with status ${result.status}`);
  renameSync(join(staging, archive), join(output, archive));
  const sha256 = createHash('sha256').update(readFileSync(join(output, archive))).digest('hex');
  writeFileSync(join(output, `${archive}.sha256`), `${sha256}  ${archive}\n`);
  writeFileSync(join(output, 'build-manifest.json'), `${JSON.stringify({
    name: project.name,
    version: project.version,
    archive,
    sha256,
    builtAt,
  }, null, 2)}\n`);
  console.log(`[package] ${join(output, archive)}`);
  console.log(`[package] SHA-256: ${sha256}`);
  console.log('[package] Standalone runtime and console; .env and account data excluded.');
} catch (error) {
  console.error(`[package] ${error.message}`);
  process.exitCode = 1;
} finally {
  if (staging && dirname(staging) === output)
    rmSync(staging, { recursive: true, force: true });
}
