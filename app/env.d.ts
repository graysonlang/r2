// esbuild loads `.html` with the `file` loader, exposing the emitted path as
// the default export.
declare module '*.html' {
  const url: string;
  export default url;
}
