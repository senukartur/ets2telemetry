import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build, type Manifest} from 'vite';
import tailwindcss from '@tailwindcss/vite';
import {describe, expect, it} from 'vitest';

// Compile the real entry page into isolated files: source-only import assertions would miss Vite's CSS hoisting.
describe('renderer stylesheet isolation', () => {
  it('emits separate dashboard and transparent overlay dependency graphs', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'ets2-renderer-entry-'));
    const chunkModules = new Map<string, string[]>();
    try {
      await build({
        configFile: false, root: path.resolve('apps/desktop'), base: './', logLevel: 'silent',
        plugins: [tailwindcss(), {name: 'capture-renderer-modules', generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type === 'chunk') chunkModules.set(output.fileName, Object.keys(output.modules));
          }
        }}],
        resolve: {alias: {'@': path.resolve('apps/desktop/src')}},
        build: {outDir: outputDirectory, emptyOutDir: true, assetsInlineLimit: 0, manifest: true},
      });
      const manifest = JSON.parse(await readFile(path.join(outputDirectory, '.vite/manifest.json'), 'utf8')) as Manifest;
      const entry = manifest['index.html'];
      const overlay = manifest['src/overlay-renderer.tsx'];
      const dashboard = manifest['src/dashboard-renderer.tsx'];
      expect(entry?.isEntry).toBe(true);
      expect(overlay?.isDynamicEntry).toBe(true);
      expect(dashboard?.isDynamicEntry).toBe(true);
      const staticClosure = (key: string, visited = new Set<string>()): string[] => {
        if (visited.has(key)) return [];
        visited.add(key);
        const chunk = manifest[key];
        expect(chunk, `missing emitted manifest entry ${key}`).toBeDefined();
        return [key, ...(chunk.imports ?? []).flatMap(dependency => staticClosure(dependency, visited))];
      };
      const stylesFor = (key: string) => staticClosure(key).flatMap(name => manifest[name].css ?? []);
      expect(stylesFor('index.html')).toEqual([]);
      const html = await readFile(path.join(outputDirectory, 'index.html'), 'utf8');
      expect(html).not.toMatch(/<link\b[^>]*rel=["']stylesheet["']/i);
      const overlayStyles = stylesFor('src/overlay-renderer.tsx');
      const dashboardStyles = stylesFor('src/dashboard-renderer.tsx');
      expect(overlayStyles).toHaveLength(1);
      expect(dashboardStyles.length).toBeGreaterThan(0);
      expect(overlayStyles.some(style => dashboardStyles.includes(style))).toBe(false);
      const overlayCss = await readFile(path.join(outputDirectory, overlayStyles[0]), 'utf8');
      expect(overlayCss).toMatch(/\.overlay-body\s*\{[^}]*background:\s*(?:transparent|0 0)[;}]/);
      expect(overlayCss).toMatch(/html:has\(\.overlay-body\)\s*\{[^}]*background:\s*(?:transparent|0 0)[;}]/);
      expect(overlayCss).not.toMatch(/@font-face|--background|--tw-|--radix-/);
      // ET-012a: the transparent overlay never blurs what is behind it (no backdrop-filter, decision L6/brief).
      expect(overlayCss).not.toMatch(/backdrop-filter/);
      const overlayModules = staticClosure('src/overlay-renderer.tsx').flatMap(key => chunkModules.get(manifest[key].file) ?? []).join('\n').replaceAll('\\', '/');
      expect(overlayModules).not.toMatch(/\/components\/ui\/|\/radix-ui\/|\/@radix-ui\/|\/index\.css|\/dashboard-renderer\.tsx|\/overlay-settings-card\.tsx/);
      // The layouts' icons are inline SVG from lucide-react, bundled into the overlay's own closure.
      expect(overlayModules).toMatch(/\/lucide-react\//);
      const dashboardCss = (await Promise.all(dashboardStyles.map(style => readFile(path.join(outputDirectory, style), 'utf8')))).join('\n');
      expect(dashboardCss).toContain('@font-face');
      expect(dashboardCss).toContain('--background');
      expect(dashboardCss).toContain('.bg-card');
    } finally {
      await rm(outputDirectory, {recursive: true, force: true});
    }
  }, 30_000);
});
