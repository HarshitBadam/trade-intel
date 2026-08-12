import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  {
    ignores: [".next/**", "next-env.d.ts"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    files: [
      "src/**/*.{js,jsx,ts,tsx,mjs,cjs}",
      "tests/**/*.{js,jsx,ts,tsx,mjs,cjs}",
      "scripts/**/*.{js,jsx,ts,tsx,mjs,cjs}",
    ],
    rules: {
      "max-lines": [
        "error",
        {
          max: 400,
          skipBlankLines: false,
          skipComments: false,
        },
      ],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-extra-non-null-assertion": "off",
    },
  },
];

export default eslintConfig;
