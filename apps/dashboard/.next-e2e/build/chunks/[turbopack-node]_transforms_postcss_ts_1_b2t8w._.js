module.exports = [
"[turbopack-node]/transforms/postcss.ts?config=[project]/apps/dashboard/postcss.config.mjs { CONFIG => \"[project]/apps/dashboard/postcss.config.mjs [postcss] (ecmascript)\" } [postcss] (ecmascript, async loader)", ((__turbopack_context__) => {

__turbopack_context__.v((parentImport) => {
    return Promise.all([
  "chunks/1tpz_1-ptnbn._.js",
  "chunks/[root-of-the-server]__1gh8za0._.js"
].map((chunk) => __turbopack_context__.l(chunk))).then(() => {
        return parentImport("[turbopack-node]/transforms/postcss.ts?config=[project]/apps/dashboard/postcss.config.mjs { CONFIG => \"[project]/apps/dashboard/postcss.config.mjs [postcss] (ecmascript)\" } [postcss] (ecmascript)");
    });
});
}),
];