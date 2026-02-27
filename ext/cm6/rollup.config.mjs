import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

export default {
  input: 'entry.mjs',
  output: {
    file: 'cm6.min.js',
    format: 'iife',
    name: 'CM6',
  },
  plugins: [
    resolve(),
    terser({
      compress: { passes: 2 },
      mangle: true,
    }),
  ],
};
