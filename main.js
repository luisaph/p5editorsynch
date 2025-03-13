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
  existingSketch
) => {
  const sketchStaticFiles = staticFiles.get(sketchPath);
  if (!sketchStaticFiles?.length) return filesData;

  const folderMap = new Map();
  folderMap.set("", rootId);

  // Create folder structure
  for (const staticFile of sketchStaticFiles) {
    if (staticFile.folder) {
      await createFolderStructure(staticFile.folder, folderMap, filesData);
    }
  }

  // Process files
  for (const staticFile of sketchStaticFiles) {
    try {
      // Check if the file exists in the filesystem
      if (fs.existsSync(staticFile.path)) {
        await processStaticFile(
          staticFile,
          folderMap,
          filesData,
          existingSketch
        );
      } else {
        console.warn(
          `Warning: Static file ${staticFile.path} not found in filesystem`
        );
        // If the sketch exists remotely, we'll keep track of this missing file
        if (existingSketch?.staticFiles) {
          existingSketch.staticFiles = existingSketch.staticFiles.filter(
            (f) =>
              !(f.name === staticFile.name && f.folder === staticFile.folder)
          );
        }
      }
    } catch (error) {
      console.error(`Error handling static file ${staticFile.name}:`, error);
    }
  }

  return filesData;
};

const createFolderStructure = async (folder, folderMap, filesData) => {
  const folderParts = folder.split(path.sep);
  let currentPath = "";

  for (const part of folderParts) {
    const parentPath = currentPath;
    currentPath = currentPath ? path.join(currentPath, part) : part;

    if (!folderMap.has(currentPath)) {
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
  }
};

const processStaticFile = async (
  staticFile,
  folderMap,
  filesData,
  existingSketch
) => {
  const parentId = folderMap.get(staticFile.folder || "");
  const existingFile = existingSketch?.staticFiles
    ? findExistingStaticFile(existingSketch, staticFile.name, staticFile.folder)
    : null;

  let fileUrl = existingFile?.url;

  // Upload if URL is missing
  if (!fileUrl) {
    const uploadResult = await apiService.uploadFile(
      staticFile.path,
      existingSketch?.id,
      parentId
    );

    if (uploadResult?.success) {
      fileUrl = uploadResult.url;
      if (existingSketch && existingSketch.staticFiles) {
        // Remove old entry if it exists
        existingSketch.staticFiles = existingSketch.staticFiles.filter(
          (f) => !(f.name === staticFile.name && f.folder === staticFile.folder)
        );
        // Add new entry
        existingSketch.staticFiles.push({
          name: staticFile.name,
          folder: staticFile.folder,
          url: fileUrl,
        });
      }
    }
  }

  const fileId = objectID().toHexString();
  const parentFolder = filesData.find((f) => f.id === parentId);
  if (parentFolder) {
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
  }
};

// Main function
const main = async () => {
  try {
    validateConfig(config);

    await apiService.login(config.username, config.password);
    const collection = await apiService.getOrCreateCollection(
      config.collectionName
    );

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
          await apiService.removeSketchFromCollection(
            collection.id,
            item.project.id
          );
          console.log(
            `Removed sketch "${item.project.name}" from collection as it no longer exists locally`
          );
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
      const existingSketch = existingSketchItem
        ? {
            id: existingSketchItem.project.id,
            name: sketchName,
            staticFiles: [],
          }
        : null;

      // Add to our tracking map
      if (existingSketch) {
        sketchStaticFilesMap.set(sketchName, existingSketch);
      }

      const { filesData, rootId } = processCodeFiles(sketchPath);
      await processStaticFiles(
        sketchPath,
        staticFiles,
        filesData,
        rootId,
        existingSketch
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

// Helper function
const findExistingStaticFile = (sketch, fileName, folder) => {
  return sketch.staticFiles?.find(
    (f) => f.name === fileName && f.folder === folder
  );
};

main();
