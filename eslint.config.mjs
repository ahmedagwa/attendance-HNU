import next from "eslint-config-next";

const config = [...next, { ignores: [".next/**", "node_modules/**", "scripts/**", "tests/load/**", "public/sw.js"] }];
export default config;
