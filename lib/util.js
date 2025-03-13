const fs = require("fs");
const path = require("path");
const objectID = require("bson-objectid");
const apiService = require("./api");

const IGNORED_FILES = [".DS_Store", "Thumbs.db"];

/**
 * Format file size in human-readable format
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted file size
 */
function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined) return "unknown size";
  if (bytes < 1024) return bytes + " bytes";
  else if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  else if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  else return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

/**
 * Find an existing static file in a sketch by name and folder
 * @param {Object} sketch - The sketch object containing static files
 * @param {string} fileName - The name of the file to find
 * @param {string} folder - The folder path of the file
 * @returns {Object|null} The found static file object or null if not found
 */
function findExistingStaticFile(sketch, fileName, folder) {
  return sketch.staticFiles?.find(
    (f) => f.name === fileName && f.folder === folder
  );
}

/**
 * Remove a static file from an existing sketch's static files list
 * @param {Object} existingSketch - Existing sketch data
 * @param {Object} staticFile - Static file to remove
 */
function removeFromExistingSketch(existingSketch, staticFile) {
  if (!existingSketch?.staticFiles) return;

  existingSketch.staticFiles = existingSketch.staticFiles.filter(
    (f) => !(f.name === staticFile.name && f.folder === staticFile.folder)
  );
}

/**
 * Add a file to the filesData structure
 * @param {Object} staticFile - Static file to add
 * @param {string} parentId - Parent folder ID
 * @param {string} fileUrl - File URL
 * @param {Array} filesData - Array of file data objects
 * @returns {boolean} Whether the file was added successfully
 */
function addFileToFilesData(staticFile, parentId, fileUrl, filesData) {
  const fileId = objectID().toHexString();
  const parentFolder = filesData.find((f) => f.id === parentId);

  if (!parentFolder) {
    console.warn(
      `Parent folder with ID ${parentId} not found for file ${staticFile.name}`
    );
    return false;
  }

  parentFolder.children.push(fileId);
  filesData.push({
    id: fileId,
    _id: fileId,
    name: path.basename(staticFile.name),
    content: "",
    fileType: "file",
    url: fileUrl,
    children: [],
  });

  return true;
}

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

/**
 * Creates a folder structure in the filesData array
 * @param {string} folder - The folder path to create
 * @param {Map} folderMap - Map of folder paths to folder IDs
 * @param {Array} filesData - Array of file data objects
 * @returns {Promise<void>}
 */
async function createFolderStructure(folder, folderMap, filesData) {
  try {
    const folderParts = folder.split(path.sep);
    let currentPath = "";

    for (const part of folderParts) {
      const parentPath = currentPath;
      currentPath = currentPath ? path.join(currentPath, part) : part;

      // Skip if this folder already exists in our map
      if (folderMap.has(currentPath)) continue;

      const folderId = objectID().toHexString();
      folderMap.set(currentPath, folderId);

      const parentId = folderMap.get(parentPath);
      const parentFolder = filesData.find((f) => f.id === parentId);

      filesData.push({
        id: folderId,
        _id: folderId,
        name: part,
        content: "",
        fileType: "folder",
        children: [],
      });

      if (parentFolder) {
        parentFolder.children.push(folderId);
      }
    }
  } catch (error) {
    console.error(`Error creating folder structure for ${folder}:`, error);
    throw error;
  }
}

/**
 * Creates all folder structures needed for static files
 * @param {Array} staticFiles - Array of static file objects
 * @param {Map} folderMap - Map of folder paths to folder IDs
 * @param {Array} filesData - Array of file data objects
 * @returns {Promise<void>}
 */
async function createFolderStructures(staticFiles, folderMap, filesData) {
  try {
    // Create all folder structures first
    for (const staticFile of staticFiles) {
      if (staticFile.folder) {
        await createFolderStructure(staticFile.folder, folderMap, filesData);
      }
    }
  } catch (error) {
    console.error("Error creating folder structures:", error);
    throw error; // Propagate error to caller
  }
}

/**
 * Process all static files in a sketch
 * @param {Array} staticFiles - Array of static file objects
 * @param {Map} folderMap - Map of folder paths to folder IDs
 * @param {Array} filesData - Array of file data objects
 * @param {Object} existingSketch - Existing sketch data if available
 * @param {Map} staticFilesMap - Map of static files by URL
 */
const processAllStaticFiles = async (
  staticFiles,
  folderMap,
  filesData,
  existingSketch,
  staticFilesMap
) => {
  const results = {
    processed: 0,
    skipped: 0,
    errors: 0,
    reused: 0,
    uploaded: 0,
  };

  console.log(`Processing ${staticFiles.length} static files...`);

  // Log existing files if available
  if (existingSketch?.staticFiles?.length > 0) {
    console.log(
      `Found ${existingSketch.staticFiles.length} existing static files in the sketch`
    );
  }

  for (const staticFile of staticFiles) {
    try {
      // Check if the file exists in the filesystem
      if (!fs.existsSync(staticFile.path)) {
        console.warn(
          `Warning: Static file ${staticFile.path} not found in filesystem`
        );
        removeFromExistingSketch(existingSketch, staticFile);
        results.skipped++;
        continue;
      }

      // Check if file already exists in the sketch
      const existingFile = existingSketch?.staticFiles
        ? findExistingStaticFile(
            existingSketch,
            staticFile.name,
            staticFile.folder
          )
        : null;

      // Get the current file size
      const fileStats = fs.statSync(staticFile.path);
      const fileSize = fileStats.size;

      // Get the existing file size from the static files map if available
      let existingFileSize = null;
      if (existingFile?.url) {
        const staticFileInfo = staticFilesMap.get(existingFile.url);
        if (staticFileInfo) {
          existingFileSize = staticFileInfo.size;
        }
      }

      // Track if this is a new upload or reusing existing URL
      const hasExistingUrl = Boolean(existingFile?.url);
      const isSameSize = hasExistingUrl && existingFileSize === fileSize;

      // Process the file
      const fileUrl = await processStaticFile(
        staticFile,
        folderMap,
        filesData,
        existingSketch,
        staticFilesMap
      );

      // Update results based on what happened
      if (fileUrl) {
        if (hasExistingUrl && isSameSize) {
          results.reused++;
        } else {
          results.uploaded++;
        }
        results.processed++;
      } else {
        results.errors++;
      }
    } catch (error) {
      console.error(`Error handling static file ${staticFile.name}:`, error);
      results.errors++;
    }
  }

  console.log(
    `Static files processing complete: ${results.processed} processed, ${results.skipped} skipped, ${results.errors} errors, ${results.reused} reused, ${results.uploaded} uploaded`
  );
};

/**
 * Process a single static file
 * @param {Object} staticFile - Static file to process
 * @param {Map} folderMap - Map of folder paths to folder IDs
 * @param {Array} filesData - Array of file data objects
 * @param {Object} existingSketch - Existing sketch data if available
 * @param {Map} staticFilesMap - Map of static files by URL
 * @returns {string} File URL if successful, null otherwise
 */
const processStaticFile = async (
  staticFile,
  folderMap,
  filesData,
  existingSketch,
  staticFilesMap
) => {
  try {
    const parentId = folderMap.get(staticFile.folder || "");
    if (!parentId) {
      throw new Error(
        `Parent folder ID not found for ${staticFile.folder || "root"}`
      );
    }

    // Get the file URL, either from existing file or by uploading
    const fileUrl = await uploadStaticFile(
      staticFile,
      existingSketch,
      parentId,
      staticFilesMap
    );

    if (!fileUrl) {
      console.warn(`No URL available for file ${staticFile.name}, skipping`);
      return null;
    }

    // Add file to filesData structure
    const added = addFileToFilesData(staticFile, parentId, fileUrl, filesData);

    return added ? fileUrl : null;
  } catch (error) {
    console.error(`Error processing static file ${staticFile.name}:`, error);
    return null;
  }
};

/**
 * Upload a static file and update the existing sketch data
 * @param {Object} staticFile - Static file to upload
 * @param {Object} existingSketch - Existing sketch data
 * @param {string} parentId - Parent folder ID
 * @param {Map} staticFilesMap - Map of static files by URL
 * @returns {string} File URL if successful, null otherwise
 */
const uploadStaticFile = async (
  staticFile,
  existingSketch,
  parentId,
  staticFilesMap
) => {
  try {
    // Check if file already exists in the sketch with the same name and path
    const existingFile = existingSketch?.staticFiles
      ? findExistingStaticFile(
          existingSketch,
          staticFile.name,
          staticFile.folder
        )
      : null;

    // Get the current file size
    const fileStats = fs.statSync(staticFile.path);
    const fileSize = fileStats.size;

    // Get the existing file size from the static files map if available
    let existingFileSize = null;
    if (existingFile?.url) {
      const staticFileInfo = staticFilesMap.get(existingFile.url);
      if (staticFileInfo) {
        existingFileSize = staticFileInfo.size;
      }
    }

    // If we have an existing file with the same name, path, and size, reuse its URL
    if (existingFile?.url && existingFileSize === fileSize) {
      console.log(
        `Reusing existing URL for unchanged file: ${
          staticFile.name
        } (${formatFileSize(fileSize)})`
      );
      return existingFile.url;
    } else if (existingFile?.url) {
      console.log(
        `File ${staticFile.name} has changed (size: ${formatFileSize(
          existingFileSize || 0
        )} -> ${formatFileSize(fileSize)}), uploading new version...`
      );
    } else {
      console.log(
        `Uploading new file: ${staticFile.name} (${formatFileSize(fileSize)})`
      );
    }

    // If we get here, we need to upload the file
    console.log(`Uploading ${staticFile.path}...`);
    const uploadResult = await apiService.uploadFile(
      staticFile.path,
      existingSketch?.id,
      parentId
    );

    if (!uploadResult?.success) {
      console.error(`Failed to upload file ${staticFile.name}`);
      return existingFile?.url || null; // Return existing URL if available, otherwise null
    }

    // Update the existing sketch data if available
    if (existingSketch?.staticFiles) {
      // Remove the old file entry if it exists
      removeFromExistingSketch(existingSketch, staticFile);

      // Add the new file entry
      existingSketch.staticFiles.push({
        name: staticFile.name,
        url: uploadResult.url,
        folder: staticFile.folder || "",
      });
    }

    // Add to the static files map
    staticFilesMap.set(uploadResult.url, {
      name: staticFile.name,
      size: fileSize,
      folder: staticFile.folder || "",
    });

    return uploadResult.url;
  } catch (error) {
    console.error(`Error uploading static file ${staticFile.name}:`, error);
    return null;
  }
};

/**
 * Process all static files for a sketch
 * @param {string} sketchPath - Path to the sketch
 * @param {Map} staticFiles - Map of sketch paths to static files
 * @param {Array} filesData - Array of file data objects
 * @param {string} rootId - Root folder ID
 * @param {Object} existingSketch - Existing sketch data if available
 * @param {Map} staticFilesMap - Map of static files by URL
 * @returns {Array} Updated filesData
 */
const processStaticFiles = async (
  sketchPath,
  staticFiles,
  filesData,
  rootId,
  existingSketch,
  staticFilesMap
) => {
  try {
    const sketchStaticFiles = staticFiles.get(sketchPath);
    if (!sketchStaticFiles?.length) return filesData;

    // Initialize folder mapping
    const folderMap = new Map();
    folderMap.set("", rootId);

    // Step 1: Create all necessary folder structures first
    await createFolderStructures(sketchStaticFiles, folderMap, filesData);

    // Step 2: Process all static files
    await processAllStaticFiles(
      sketchStaticFiles,
      folderMap,
      filesData,
      existingSketch,
      staticFilesMap
    );

    return filesData;
  } catch (error) {
    console.error(
      `Error processing static files for sketch ${sketchPath}:`,
      error
    );
    // Return the original filesData to avoid data corruption
    return filesData;
  }
};

module.exports = {
  getSketches,
  createFolderStructure,
  createFolderStructures,
  formatFileSize,
  findExistingStaticFile,
  removeFromExistingSketch,
  addFileToFilesData,
  processAllStaticFiles,
  processStaticFile,
  uploadStaticFile,
  processStaticFiles,
};
