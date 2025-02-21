const fs = require("fs");
const path = require("path");
const objectID = require("bson-objectid");

const IGNORED_FILES = [".DS_Store", "Thumbs.db"];

function findStaticFiles(dir, baseDir) {
  const files = [];
  const entries = fs.readdirSync(dir);

  for (const entry of entries) {
    // Skip ignored files
    if (IGNORED_FILES.includes(entry)) {
      continue;
    }

    const fullPath = path.join(dir, entry);
    const stats = fs.statSync(fullPath);

    if (stats.isDirectory()) {
      // Recursively search subdirectories
      files.push(...findStaticFiles(fullPath, baseDir));
    } else {
      const ext = path.extname(entry).toLowerCase();
      // Filter for non-code files
      if (
        ![".html", ".css", ".js", ".json"].includes(ext) &&
        entry !== "sketchesMap.json"
      ) {
        // Calculate relative path from sketch root
        const relativePath = path.relative(baseDir, dir);
        files.push({
          name: entry,
          path: fullPath,
          folder: relativePath,
        });
      }
    }
  }

  return files;
}

function getSketches(folder) {
  const entries = fs.readdirSync(folder);
  const sketches = [];
  const staticFiles = new Map();

  for (const entry of entries) {
    const fullPath = path.join(folder, entry);
    const stats = fs.statSync(fullPath);

    if (stats.isDirectory()) {
      // Check if this directory is a sketch (contains index.html)
      if (fs.existsSync(path.join(fullPath, "index.html"))) {
        sketches.push(fullPath);
        // Find all static files in the sketch directory and its subdirectories
        const sketchFiles = findStaticFiles(fullPath, fullPath);
        if (sketchFiles.length > 0) {
          staticFiles.set(fullPath, sketchFiles);
        }
      } else {
        // Recursively check subdirectories
        const { sketches: subSketches, staticFiles: subStaticFiles } =
          getSketches(fullPath);
        sketches.push(...subSketches);
        for (const [sketchPath, files] of subStaticFiles) {
          staticFiles.set(sketchPath, files);
        }
      }
    }
  }

  return { sketches, staticFiles };
}

async function createFolderStructure(folderPath, rootId, filesData) {
  const folderNames = folderPath.split(path.sep).filter((name) => name !== "");
  let currentParentId = rootId;

  for (const folderName of folderNames) {
    const folderId = objectID().toHexString();

    filesData.push({
      id: folderId,
      _id: folderId,
      name: folderName,
      content: "",
      fileType: "folder",
      children: [],
    });

    // Add this folder as a child of its parent
    const parentFolder = filesData.find((f) => f.id === currentParentId);
    if (parentFolder) {
      parentFolder.children.push(folderId);
    }

    currentParentId = folderId;
  }

  return currentParentId;
}

module.exports = {
  getSketches,
  createFolderStructure,
};
