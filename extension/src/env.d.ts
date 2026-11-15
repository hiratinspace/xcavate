/** CSS imported as a string (esbuild plugin in build.mjs; Vite/vitest support `?inline` natively). */
declare module "*.css?inline" {
  const css: string;
  export default css;
}
