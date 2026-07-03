/**
 * Browser-safe entry point (`@gimpish/core/model`): the scene schema, pure
 * geometry/color helpers, and the editor's box/delta math — no node imports,
 * no sharp/onnxruntime. The web app imports its types and math from here so
 * there is exactly one definition of the scene contract.
 */

export * from "./color.ts";
export * from "./editor.ts";
export * from "./geometry.ts";
export * from "./schema.ts";
