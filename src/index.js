// Copy all files under assets/ into dist/ alongside the bundle.
import { paths as assetPaths } from 'virtual:glob' with { pattern: 'assets/**/*.{png,jpg}', baseDir: '..' };

export { assetPaths as imagePaths };
