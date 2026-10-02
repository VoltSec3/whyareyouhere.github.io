/**
 * Resolves the extensionless relative imports that `src` uses for its bundler.
 *
 * Node's ESM resolver matches specifiers literally, so `import { fft } from
 * "./fft"` inside src/lib/audio/denoise.ts fails under plain Node. Rather than
 * add extensions to every source file - which would fight the bundler - this
 * hook retries a failed relative specifier with the extensions the tree uses.
 */

const SUFFIXES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith(".") || specifier.startsWith("/");
    if (!relative) throw error;

    for (const suffix of SUFFIXES) {
      try {
        return await nextResolve(specifier + suffix, context);
      } catch {
        // Try the next extension.
      }
    }
    throw error;
  }
}
