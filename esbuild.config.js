const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

/** Plugin: copy webview static assets (CSS) into dist/webview after every build. */
const copyWebviewAssets = {
  name: 'copy-webview-assets',
  setup(build) {
    build.onEnd(() => {
      const src = path.join(__dirname, 'webview');
      const dst = path.join(__dirname, 'dist', 'webview');
      if (!fs.existsSync(src)) return;
      fs.mkdirSync(dst, { recursive: true });
      for (const file of fs.readdirSync(src)) {
        // main.js is bundled by esbuild; everything else is copied verbatim.
        if (file === 'main.js') continue;
        fs.copyFileSync(path.join(src, file), path.join(dst, file));
      }
    });
  },
};

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info',
  plugins: [copyWebviewAssets],
};

const webviewConfig = {
  entryPoints: ['webview/main.js'],
  bundle: true,
  outfile: 'dist/webview/main.js',
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info',
};

(async () => {
  if (isWatch) {
    const ec = await esbuild.context(extensionConfig);
    const wc = await esbuild.context(webviewConfig);
    await Promise.all([ec.watch(), wc.watch()]);
    console.log('[esbuild] watching extension + webview...');
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
