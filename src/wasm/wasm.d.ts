// C sources are compiled by esp's emcc esbuild plugin and imported as an
// Emscripten ES6 module factory (MODULARIZE + EXPORT_ES6). The default export is
// the factory; the resolved module's shape is described by WasmModule below.
declare module '*.c' {
  const factory: (overrides?: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
