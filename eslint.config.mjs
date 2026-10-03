import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  // demo/ (the static GitHub Pages demo) was removed in the upstream merge; nothing here references it anymore.
  ...coreWebVitals,
  ...typescript,
  {
    // The Electron desktop shell (pi#30) is a self-contained CommonJS package
    // with its own runtime (Electron main process); the Next.js/TS rules —
    // including no-require-imports — do not apply to it.
    ignores: ["desktop/**"],
  },
  {
    // mobile/ is the Capacitor Android shell: Gradle build outputs,
    // Capacitor's node_modules, and vendored platform scaffolding, all
    // generated or third-party. None of it is this app's source; linting a
    // build artifact (mergeDebugAssets/native-bridge.js) is what made the
    // warning baseline nonzero in the first place.
    ignores: ["mobile/**"],
  },
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
