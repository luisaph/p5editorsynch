const fs = require("fs");
const path = require("path");

function getSketches(folder) {
  const entries = fs.readdirSync(folder);
  const sketches = [];

  for (const entry of entries) {
    const fullPath = path.join(folder, entry);
    const stats = fs.statSync(fullPath);

    if (stats.isDirectory()) {
      // Recursively check this directory
      sketches.push(...getSketches(fullPath));
    } else if (entry === 'index.html') {
      sketches.push(folder); // Add the folder path if it contains index.html
    }
  }

  return sketches;
}

module.exports = {
  getSketches
};