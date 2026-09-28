// ESM resolve hook for bare @/* and open-sse/* imports, plus extensionless relatives (debug-only).
import fs from "fs";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tryFile(abs) {
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return pathToFileURL(abs).href;
    }
  } catch {}
  return null;
}

function resolveAbsCandidates(abs) {
  const candidates = [abs];
  if (!/\.(js|mjs|cjs|json|node|ts)$/.test(abs)) {
    candidates.push(abs + ".js", abs + ".mjs", path.join(abs, "index.js"));
  }
  for (const c of candidates) {
    const hit = tryFile(c);
    if (hit) return hit;
  }
  return null;
}

function resolveAlias(specifier, parentURL) {
  if (specifier.startsWith("@/")) {
    return resolveAbsCandidates(path.join(root, "src", specifier.slice(2)));
  }
  if (specifier === "open-sse") {
    return resolveAbsCandidates(path.join(root, "open-sse/index.js"));
  }
  if (specifier.startsWith("open-sse/")) {
    return resolveAbsCandidates(
      path.join(root, "open-sse", specifier.slice("open-sse/".length)),
    );
  }
  // Extensionless relative/absolute path imports (Next/bundler style)
  if (
    (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) &&
    !/\.(js|mjs|cjs|json|node)(\?|$)/.test(specifier)
  ) {
    let baseDir = root;
    if (parentURL && parentURL.startsWith("file:")) {
      baseDir = path.dirname(fileURLToPath(parentURL));
    }
    const abs = path.resolve(baseDir, specifier);
    return resolveAbsCandidates(abs);
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const mapped = resolveAlias(specifier, context.parentURL);
  if (mapped) {
    return { shortCircuit: true, url: mapped };
  }
  return nextResolve(specifier, context);
}
