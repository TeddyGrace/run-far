import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

export default defineConfig({
  headLinkOptions: { preset: "2023" },
  preset: {
    ...minimal2023Preset,
    maskable: {
      ...minimal2023Preset.maskable,
      // Match the source icon's own background so the safe-zone padding the generator
      // adds doesn't show up as a mismatched white border once the OS applies its mask.
      resizeOptions: { background: "#121815" },
    },
  },
  images: ["public/favicon.svg"],
});
