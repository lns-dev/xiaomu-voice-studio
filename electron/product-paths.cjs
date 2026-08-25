const path = require('node:path');

function createProductPaths({ isPackaged, softwareRoot, developmentRoot }) {
  const productDataRoot = path.resolve(isPackaged ? softwareRoot : developmentRoot);
  return {
    productDataRoot,
    artifactRoot: path.join(productDataRoot, 'outputs'),
    modelRoot: path.join(productDataRoot, 'models')
  };
}

module.exports = { createProductPaths };
