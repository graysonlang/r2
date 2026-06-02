# esd

A minimal example project demonstrating how to use [`@graysonlang/esp`](https://github.com/graysonlang/esp) in an independent repo, with matching VS Code configuration for building and debugging.

## What this is

`esp` is a set of esbuild plugins and a build runner designed to streamline frontend development. This repo exists to validate that esp's example configuration and VS Code integration work correctly outside of the esp repo itself — i.e., as a real consumer would use it.

## Structure

- [scripts/build.mjs](scripts/build.mjs) — the build script, which wires up esp's `runBuild` runner with project-specific esbuild options (entry points, plugins, output directory, etc.)
- [app/main.js](app/main.js) — the app entry point
- [.vscode/tasks.json](.vscode/tasks.json) — VS Code tasks that invoke the `vscode:build` and `vscode:debug` npm scripts, with a custom problem matcher to surface esbuild errors and warnings inline in the editor
- [.vscode/launch.json](.vscode/launch.json) — VS Code launch configurations that attach Chrome to the dev server with source maps, using the debug tasks as `preLaunchTask`

## Usage

Install dependencies:

```sh
npm install
```

**Build** (one-shot, minified):

```sh
npm run build
```

**Dev server** (watch mode, source maps, auto-launches browser):

```sh
npm run dev
```

**VS Code** — open the workspace (`esd.code-workspace`), then use the default build task (`Cmd+Shift+B`) to build, or launch "Debug in Chrome" from the Run and Debug panel to start the dev server and attach the debugger.

## VS Code integration notes

The tasks in [.vscode/tasks.json](.vscode/tasks.json) use a `background` problem matcher that watches for the `[esbuild-ready]` sentinel line emitted by esp's dev server, which tells VS Code when the initial build is complete and the browser can be launched. The "Kill debug server" task tears down the watch process when the debug session ends.
