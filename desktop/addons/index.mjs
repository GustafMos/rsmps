// Entry of the add-ons bundle (see desktop/scripts/bundle-modules.mjs).
import catalogueRaw from './catalogue.json';
export { parseCatalogue, createAddonManager, probeAddon, probeFfmpeg, sha256File } from './manager.mjs';
export { createSplatTrainService, SplatTrainError } from './splat-train.mjs';
export { createExportService, ExportError } from './export.mjs';
export { createLiveService, LiveError } from './live.mjs';
export { runAddonSmoke, prepareAddonSmoke } from './smoke.mjs';
export { catalogueRaw };
