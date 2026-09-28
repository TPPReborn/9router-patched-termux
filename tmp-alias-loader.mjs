import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = '/data/data/com.termux/files/home/9router';

function resolveLocal(baseDir, rel) {
  let file = path.join(baseDir, rel);
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.json')) {
    return file;
  }
  if (fs.existsSync(file + '.js')) return file + '.js';
  if (fs.existsSync(path.join(file, 'index.js'))) return path.join(file, 'index.js');
  return file + '.js';
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const file = resolveLocal(path.join(root, 'src'), specifier.slice(2));
    return nextResolve(pathToFileURL(file).href, context);
  }
  if (specifier === 'open-sse' || specifier.startsWith('open-sse/')) {
    const rel = specifier === 'open-sse' ? 'index.js' : specifier.slice('open-sse/'.length);
    const file = resolveLocal(path.join(root, 'open-sse'), rel);
    return nextResolve(pathToFileURL(file).href, context);
  }
  return nextResolve(specifier, context);
}
