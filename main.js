const fs = require("fs");
const path = require("path");
const objectID = require("bson-objectid");
const core = require("@actions/core");
require("dotenv").config();

const apiService = require("./lib/api");
const { getSketches } = require("./lib/util");

// Constants
const TEXT_FILE_EXTENSIONS = [".html", ".css", ".js", ".json"];
const DEFAULT_SELECTED_FILE = "sketch.js";

// Configuration
const config = {
  username: core.getInput("p5-username") || process.env.P5_USERNAME,
  password: core.getInput("p5-password") || process.env.P5_PASSWORD,
  sketchesFolder: path.join(
    process.env.GITHUB_WORKSPACE,
    core.getInput("sketch-folder") || process.env.SKETCHES_FOLDER || "sketches"
  ),
  collectionName:
    core.getInput("collection-name") ||
    process.env.COLLECTION_NAME ||
    "My Sketches",
};

// Error handling
const handleError = (message, error) => {
  console.error(message, error.response ? error.response.data : error.message);
  process.exit(1);
};

// Input validation
const validateConfig = (config) => {
  if (!config.username || !config.password) {
    handleError(
      "Configuration Error",
      new Error(
        "No username or password provided. Please set the P5_USERNAME and P5_PASSWORD environment variables."
      )
    );
  }

  if (!fs.existsSync(config.sketchesFolder)) {
    handleError(
      "Configuration Error",
      new Error(
        `The "${config.sketchesFolder}" folder does not exist. Please check if "SKETCHES_FOLDER" is set correctly.`
      )
    );
  }
};

// File processing
const processCodeFiles = (sketchPath) => {
  const filesData = [];
  const rootId = objectID().toHexString();

  filesData.push({
    id: rootId,
    _id: rootId,
    name: "root",
    content: "",
    fileType: "folder",
    children: [],
  });

  const codeFiles = fs.readdirSync(sketchPath).filter((file) => {
    const fileExt = path.extname(file).toLowerCase();
    return TEXT_FILE_EXTENSIONS.includes(fileExt);
  });

  for (const fileName of codeFiles) {
    const filePath = path.join(sketchPath, fileName);
    const content = fs.readFileSync(filePath, "utf8");
    const fileId = objectID().toHexString();

    filesData.push({
      id: fileId,
      _id: fileId,
      name: fileName,
      content: content,
      fileType: "file",
      isSelectedFile: fileName === DEFAULT_SELECTED_FILE,
      children: [],
    });

    filesData[0].children.push(fileId);
  }

  return { filesData, rootId };
};

// Static file handling
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

/**
 * Creates all folder structures needed for static files
 * @param {Array} staticFiles - Array of static file objects
 * @param {Map} folderMap - Map of folder paths to folder IDs
 * @param {Array} filesData - Array of file data objects
 */
const createFolderStructures = async (staticFiles, folderMap, filesData) => {
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
};

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
 * Remove a static file from an existing sketch's static files list
 * @param {Object} existingSketch - Existing sketch data
 * @param {Object} staticFile - Static file to remove
 */
const removeFromExistingSketch = (existingSketch, staticFile) => {
  if (!existingSketch?.staticFiles) return;

  existingSketch.staticFiles = existingSketch.staticFiles.filter(
    (f) => !(f.name === staticFile.name && f.folder === staticFile.folder)
  );
};

const createFolderStructure = async (folder, folderMap, filesData) => {
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
};

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
    addFileToFilesData(staticFile, parentId, fileUrl, filesData);

    return fileUrl;
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

    const fileUrl = uploadResult.url;
    console.log(`Successfully uploaded ${staticFile.name}`);

    // Update existing sketch data if available
    if (existingSketch && existingSketch.staticFiles) {
      // Remove old entry if it exists
      removeFromExistingSketch(existingSketch, staticFile);

      // Add new entry with size information
      existingSketch.staticFiles.push({
        name: staticFile.name,
        folder: staticFile.folder,
        url: fileUrl,
        size: fileSize,
      });
    }

    return fileUrl;
  } catch (error) {
    console.error(`Error uploading static file ${staticFile.name}:`, error);
    // If upload fails but we have an existing URL, return that
    const existingFile = existingSketch?.staticFiles
      ? findExistingStaticFile(
          existingSketch,
          staticFile.name,
          staticFile.folder
        )
      : null;
    return existingFile?.url || null;
  }
};

/**
 * Format file size in human-readable format
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted file size
 */
const formatFileSize = (bytes) => {
  if (bytes === null || bytes === undefined) return "unknown size";
  if (bytes < 1024) return bytes + " bytes";
  else if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  else if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  else return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
};

/**
 * Add a file to the filesData structure
 * @param {Object} staticFile - Static file to add
 * @param {string} parentId - Parent folder ID
 * @param {string} fileUrl - File URL
 * @param {Array} filesData - Array of file data objects
 */
const addFileToFilesData = (staticFile, parentId, fileUrl, filesData) => {
  const fileId = objectID().toHexString();
  const parentFolder = filesData.find((f) => f.id === parentId);

  if (!parentFolder) {
    console.warn(
      `Parent folder with ID ${parentId} not found for file ${staticFile.name}`
    );
    return;
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
};

// Main function
const main = async () => {
  try {
    validateConfig(config);

    await apiService.login(config.username, config.password);
    const collection = await apiService.getOrCreateCollection(
      config.collectionName
    );

    // Get all static files from the API
    console.log("Fetching information about all static files...");
    const allStaticFiles = await apiService.getStaticFiles();
    console.log(`Found ${allStaticFiles.length} static files in total.`);

    // Create a map of static files by URL for quick lookup
    const staticFilesMap = new Map();
    for (const file of allStaticFiles) {
      staticFilesMap.set(file.url, file);
    }

    // Get local sketches
    const { sketches, staticFiles } = getSketches(config.sketchesFolder);
    const localSketchNames = sketches.map((sketchPath) =>
      path.basename(sketchPath)
    );

    // Create a map to track static files for each sketch during this run
    const sketchStaticFilesMap = new Map();

    // Remove sketches that aren't in local folder anymore
    if (collection) {
      for (const item of collection.items) {
        if (!item.isDeleted && !localSketchNames.includes(item.project.name)) {
          // First remove from collection
          await apiService.removeSketchFromCollection(
            collection.id,
            item.project.id
          );

          // Then delete the sketch itself
          const deleteResult = await apiService.deleteSketch(
            item.project.id,
            item.project.name
          );

          if (deleteResult) {
            console.log(
              `Removed and deleted sketch "${item.project.name}" as it no longer exists locally`
            );
          } else {
            console.log(
              `Removed sketch "${item.project.name}" from collection, but failed to delete it from the server`
            );
          }
        }
      }
    }

    // Process each local sketch
    for (const sketchPath of sketches) {
      const sketchName = path.basename(sketchPath);

      // Find if the sketch already exists in the collection
      const existingSketchItem = collection?.items?.find(
        (item) => !item.isDeleted && item.project.name === sketchName
      );

      // Create a structure to track static files for this sketch
      let existingSketch = null;

      if (existingSketchItem) {
        console.log(`Fetching details for existing sketch "${sketchName}"...`);
        // Get full sketch details including files
        const sketchDetails = await apiService.getSketch(
          existingSketchItem.project.id
        );

        if (sketchDetails) {
          // Initialize the sketch object
          existingSketch = {
            id: existingSketchItem.project.id,
            name: sketchName,
            staticFiles: [],
          };

          // Extract static file information from the sketch details
          if (sketchDetails.files && Array.isArray(sketchDetails.files)) {
            // Find files with URLs (these are static files)
            const staticFileEntries = sketchDetails.files.filter(
              (file) => file.fileType === "file" && file.url
            );

            // Build folder path map
            const folderPathMap = new Map();
            folderPathMap.set("", ""); // Root folder

            // Map folder IDs to paths
            sketchDetails.files.forEach((file) => {
              if (file.fileType === "folder") {
                // Find parent folder path
                const parentFolder = sketchDetails.files.find(
                  (f) => f.children && f.children.includes(file.id)
                );

                if (parentFolder) {
                  const parentPath = folderPathMap.get(parentFolder.id) || "";
                  folderPathMap.set(
                    file.id,
                    parentPath ? `${parentPath}/${file.name}` : file.name
                  );
                }
              }
            });

            // Extract static file information
            for (const file of staticFileEntries) {
              // Find parent folder
              const parentFolder = sketchDetails.files.find(
                (f) => f.children && f.children.includes(file.id)
              );

              if (parentFolder) {
                const folderPath = folderPathMap.get(parentFolder.id) || "";

                // Find size information from the static files map using URL
                let size = null;
                const staticFileInfo = staticFilesMap.get(file.url);
                if (staticFileInfo) {
                  size = staticFileInfo.size;
                }

                // Add to static files list
                existingSketch.staticFiles.push({
                  name: file.name,
                  folder: folderPath,
                  url: file.url,
                  size: size,
                });
              }
            }

            console.log(
              `Found ${existingSketch.staticFiles.length} existing static files in sketch "${sketchName}"`
            );
          }

          // Add to our tracking map
          sketchStaticFilesMap.set(sketchName, existingSketch);
        }
      }

      const { filesData, rootId } = processCodeFiles(sketchPath);
      await processStaticFiles(
        sketchPath,
        staticFiles,
        filesData,
        rootId,
        existingSketch,
        staticFilesMap
      );

      if (existingSketch) {
        await apiService.updateSketch(existingSketch.id, sketchName, filesData);
        console.log(`Updated existing sketch "${sketchName}"`);
      } else {
        const sketch = await apiService.createSketch(sketchName, filesData);
        if (sketch?.id) {
          const newSketchInfo = {
            id: sketch.id,
            name: sketchName,
            staticFiles: [],
          };

          // Process static files for the new sketch
          const sketchStaticFiles = staticFiles.get(sketchPath);
          if (sketchStaticFiles && sketchStaticFiles.length > 0) {
            for (const staticFile of sketchStaticFiles) {
              const fileData = filesData.find(
                (f) =>
                  f.fileType === "file" &&
                  f.name === path.basename(staticFile.name) &&
                  f.url
              );

              if (fileData) {
                newSketchInfo.staticFiles.push({
                  name: staticFile.name,
                  folder: staticFile.folder,
                  url: fileData.url,
                });
              }
            }
          }

          // Add to our tracking map
          sketchStaticFilesMap.set(sketchName, newSketchInfo);

          await apiService.addSketchToCollection(
            collection.id,
            sketch.id,
            sketchName
          );
          console.log(
            `Created new sketch "${sketchName}" and added to collection`
          );
        }
      }
    }

    console.log("All sketches processed successfully");
  } catch (error) {
    handleError("An error occurred:", error);
  }
};

/**
 * Find an existing static file in a sketch by name and folder
 * @param {Object} sketch - The sketch object containing static files
 * @param {string} fileName - The name of the file to find
 * @param {string} folder - The folder path of the file
 * @returns {Object|null} The found static file object or null if not found
 */
const findExistingStaticFile = (sketch, fileName, folder) => {
  return sketch.staticFiles?.find(
    (f) => f.name === fileName && f.folder === folder
  );
};

main();
